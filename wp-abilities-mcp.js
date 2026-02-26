#!/usr/bin/env node
/**
 * wp-abilities-mcp v1.0.0
 *
 * One MCP to Rule Your WordPress World.
 *
 * Unified multi-site MCP bridge for WordPress Abilities API. Replaces
 * mcp-ssh-bridge and mcp-http-bridge with a single STDIO server that
 * routes tool calls to any configured WordPress site via SSH or HTTP.
 *
 * Usage:
 *   node wp-abilities-mcp.js                                    (uses wp-sites.json)
 *   node wp-abilities-mcp.js --config=/path/to/wp-sites.json    (explicit config)
 *   node wp-abilities-mcp.js --host=<ssh-host> --path=<wp-path> (legacy single-site)
 *   node wp-abilities-mcp.js --register [--name=<name>]         (Claude Desktop setup)
 *
 * @package Influencentricity/wp-abilities-mcp
 * @version 1.0.0
 * @license GPL-2.0-or-later
 */

'use strict';

const { createLogger } = require('./lib/logger');
const { loadConfig, buildSiteKeyEnum } = require('./lib/config');
const { ConnectionPool } = require('./lib/connection-pool');
const { sanitizeToolsList, isToolsListResponse } = require('./lib/sanitizer');
const { injectSiteParam, extractSiteParam } = require('./lib/tool-injector');
const { SshTransport } = require('./lib/transports/ssh-transport');
const { ToolCatalog } = require('./lib/tool-catalog');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = {};
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, ...rest] = arg.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  }
});

const debug    = !!args.debug;
const register = !!args.register;

// ---------------------------------------------------------------------------
// Registration mode (--register)
// ---------------------------------------------------------------------------

if (register) {
  const { registerClaudeDesktop } = require('./lib/register');
  registerClaudeDesktop({ name: args.name || 'wordpress', configPath: args.config });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

const log = createLogger(debug);
log('wp-abilities-mcp v1.0.0 starting');

// Ensure SSH agent is available (macOS launchd discovery)
SshTransport.ensureSshAuthSock();

let config;
try {
  config = loadConfig(args);
} catch (err) {
  process.stderr.write(`wp-abilities-mcp: ${err.message}\n`);
  process.exit(1);
}

const isMultiSite = config._isMultiSite;
const siteKeys = buildSiteKeyEnum(config);
log(`Config loaded: ${siteKeys.length} site(s): ${siteKeys.join(', ')} (default: ${config.defaultSite})`);
log(`Multi-site mode: ${isMultiSite}`);

const pool = new ConnectionPool(config, log);
const catalog = new ToolCatalog(config, log);

if (catalog.isEnabled()) {
  log('Tool filtering enabled');
} else {
  log('Tool filtering disabled (no toolFilter in config or enabled: false)');
}

// ---------------------------------------------------------------------------
// Synthetic bridge tools (handled locally, never forwarded to WordPress)
// ---------------------------------------------------------------------------

const BRIDGE_TOOLS = [
  {
    name: 'wp_bridge_health',
    description: 'Check connectivity status of all configured WordPress sites. Returns status (connected/reachable/unreachable) and latency for each site.',
    inputSchema: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          description: 'Optional: check only this site. Omit to check all configured sites.',
        },
      },
    },
  },
  {
    name: 'wp_browse_tools',
    description: 'List available WordPress tool categories with tool counts. Shows which categories are currently loaded. Use wp_load_tools to activate categories.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wp_load_tools',
    description: 'Activate WordPress tool categories to make their tools available. After loading, the tools list is automatically refreshed.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Category names to activate (e.g. ["fluent-crm", "content", "media"]). Use wp_browse_tools to see available categories.',
        },
        deactivate: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: category names to deactivate (unload from the tools list).',
        },
      },
      required: ['categories'],
    },
  },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let defaultTransport = null;
let cachedInitRequest = null;
let cachedInitNotification = null;
let clientProtocolVersion = null;
let initHandshakeComplete = false;

// Queue for messages that arrive before the default transport is ready
const MAX_EARLY_QUEUE = 50;
let earlyQueue = [];

// ---------------------------------------------------------------------------
// Client STDIO processing
// ---------------------------------------------------------------------------

let inputBuffer = '';

process.stdin.on('data', (chunk) => {
  inputBuffer += chunk.toString();

  let newlineIdx;
  while ((newlineIdx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, newlineIdx);
    inputBuffer = inputBuffer.slice(newlineIdx + 1);
    if (line.trim()) handleClientMessage(line.trim());
  }
});

process.stdin.on('end', () => {
  log('Client stdin closed — shutting down');
  shutdown();
});

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

function handleClientMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    log(`Non-JSON from client (dropped): ${line.substring(0, 200)}`);
    return;
  }

  log(`CLIENT > BRIDGE: ${msg.method || 'response'} (id=${msg.id})`);

  // Cache initialize request
  if (msg.method === 'initialize') {
    cachedInitRequest = msg;
    if (msg.params && msg.params.protocolVersion) {
      clientProtocolVersion = msg.params.protocolVersion;
    }
    // Forward to default transport
    forwardToDefault(line);
    return;
  }

  // Cache initialized notification
  if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    cachedInitNotification = msg;
    initHandshakeComplete = true;
    pool.setHandshakeCache(cachedInitRequest, cachedInitNotification, clientProtocolVersion);
    forwardToDefault(line);
    return;
  }

  // tools/list — route to default, then inject site param
  if (msg.method === 'tools/list') {
    forwardToDefault(line);
    return;
  }

  // tools/call — check for bridge tools first, then route
  if (msg.method === 'tools/call') {
    if (msg.params && isBridgeTool(msg.params.name)) {
      handleBridgeToolCall(msg);
      return;
    }
    handleToolsCall(msg);
    return;
  }

  // resources/list — handle locally
  if (msg.method === 'resources/list') {
    handleResourcesList(msg);
    return;
  }

  // resources/read — handle locally for our URIs
  if (msg.method === 'resources/read') {
    if (msg.params && msg.params.uri === 'wp-abilities://sites') {
      handleResourcesReadSites(msg);
      return;
    }
    // Unknown resource — forward to default
    forwardToDefault(line);
    return;
  }

  // Everything else — forward to default
  forwardToDefault(line);
}

function forwardToDefault(line) {
  if (defaultTransport) {
    defaultTransport.send(line);
  } else {
    if (earlyQueue.length >= MAX_EARLY_QUEUE) {
      log('Early queue full — rejecting message');
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          sendToClient(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32603, message: 'Server not ready — queue full' }
          }));
        }
      } catch (e) { /* non-JSON, drop */ }
      return;
    }
    earlyQueue.push(line);
  }
}

function drainEarlyQueue() {
  if (earlyQueue.length === 0) return;
  log(`Draining ${earlyQueue.length} early queued message(s)`);
  const queued = earlyQueue.slice();
  earlyQueue = [];
  for (const line of queued) {
    if (defaultTransport) defaultTransport.send(line);
  }
}

// ---------------------------------------------------------------------------
// Bridge tool helpers
// ---------------------------------------------------------------------------

const BRIDGE_TOOL_NAMES = new Set(BRIDGE_TOOLS.map(t => t.name));

function isBridgeTool(name) {
  return BRIDGE_TOOL_NAMES.has(name);
}

function injectBridgeTools(msg) {
  if (!msg.result || !Array.isArray(msg.result.tools)) return;
  for (const tool of BRIDGE_TOOLS) {
    msg.result.tools.push(tool);
  }
}

async function handleBridgeToolCall(msg) {
  const toolName = msg.params.name;
  const toolArgs = msg.params.arguments || {};

  if (toolName === 'wp_bridge_health') {
    const keysToCheck = toolArgs.site ? [toolArgs.site] : siteKeys;
    const lines = [];

    for (const key of keysToCheck) {
      try {
        const result = await pool.healthCheck(key);
        let line = `${key}: ${result.status} (${result.latencyMs}ms)`;
        if (result.error) line += ` — ${result.error}`;
        lines.push(line);
      } catch (err) {
        lines.push(`${key}: error — ${err.message}`);
      }
    }

    sendToClient(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: lines.join('\n') }],
      },
    }));
    return;
  }

  if (toolName === 'wp_browse_tools') {
    if (!catalog.isEnabled() || !catalog.fullTools) {
      sendToClient(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          content: [{ type: 'text', text: 'Tool filtering is not enabled or tools have not been loaded yet.' }],
        },
      }));
      return;
    }

    const summary = catalog.getCategorySummary();
    const lines = summary.map(c =>
      `${c.active ? '[LOADED]' : '       '} ${c.name} (${c.toolCount} tools)`
    );
    lines.push('');
    lines.push(`Total: ${catalog.fullTools.length} tools in ${summary.length} categories`);
    lines.push(`Loaded: ${summary.filter(c => c.active).reduce((n, c) => n + c.toolCount, 0)} tools`);
    lines.push('');
    lines.push('Use wp_load_tools with categories array to activate.');

    sendToClient(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        content: [{ type: 'text', text: lines.join('\n') }],
      },
    }));
    return;
  }

  if (toolName === 'wp_load_tools') {
    if (!catalog.isEnabled() || !catalog.fullTools) {
      sendToClient(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          content: [{ type: 'text', text: 'Tool filtering is not enabled or tools have not been loaded yet.' }],
        },
      }));
      return;
    }

    const toActivate = toolArgs.categories || [];
    const toDeactivate = toolArgs.deactivate || [];

    if (toDeactivate.length > 0) {
      catalog.deactivateCategories(toDeactivate);
    }

    const activated = catalog.activateCategories(toActivate);
    const lines = [];

    if (activated.length > 0) {
      lines.push(`Activated: ${activated.join(', ')}`);
    }
    if (toDeactivate.length > 0) {
      lines.push(`Deactivated: ${toDeactivate.join(', ')}`);
    }
    if (activated.length === 0 && toDeactivate.length === 0) {
      lines.push('No changes — categories may already be active or not found.');
    }

    const filtered = catalog.getFilteredTools();
    lines.push(`Tools now available: ${filtered.length}/${catalog.fullTools.length}`);

    sendToClient(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        content: [{ type: 'text', text: lines.join('\n') }],
      },
    }));

    // Notify client that tools list has changed so it re-fetches
    if (activated.length > 0 || toDeactivate.length > 0) {
      sendToClient(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      }));
      log(`Sent tools/list_changed notification (activated: ${activated.join(',')})`);
    }
    return;
  }

  // Unknown bridge tool — should not happen
  sendToClient(JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Unknown bridge tool: ${toolName}` },
  }));
}

// ---------------------------------------------------------------------------
// tools/call routing
// ---------------------------------------------------------------------------

async function handleToolsCall(msg) {
  const toolArgs = msg.params && msg.params.arguments ? msg.params.arguments : {};
  const { site, cleanArgs } = extractSiteParam(toolArgs, config.defaultSite);

  log(`tools/call: ${msg.params.name} → site=${site}`);

  // Build the modified message with site stripped from args
  const modifiedMsg = {
    ...msg,
    params: {
      ...msg.params,
      arguments: cleanArgs,
    }
  };
  const modifiedLine = JSON.stringify(modifiedMsg);

  // Route to the correct transport
  if (site === config.defaultSite) {
    // Default site — use existing transport
    forwardToDefault(modifiedLine);
    return;
  }

  try {
    const transport = await pool.getTransport(site);
    // Set onMessage callback to forward responses to client
    if (!transport.onMessage) {
      transport.onMessage = (parsedMsg, rawLine) => {
        handleTransportMessage(parsedMsg, rawLine);
      };
    }
    transport.send(modifiedLine);
  } catch (err) {
    log(`Route to site "${site}" failed: ${err.message}`);
    sendToClient(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: `Failed to connect to site "${site}": ${err.message}` }
    }));
  }
}

// ---------------------------------------------------------------------------
// Transport response handling
// ---------------------------------------------------------------------------

function handleTransportMessage(parsedMsg, rawLine) {
  if (!parsedMsg) {
    if (rawLine) log(`Non-JSON from transport (dropped): ${rawLine.substring(0, 200)}`);
    return;
  }

  // Sanitize tools/list responses
  if (isToolsListResponse(parsedMsg)) {
    sanitizeToolsList(parsedMsg);

    // Cache full tools list in catalog (before filtering)
    if (catalog.isEnabled() && parsedMsg.result && parsedMsg.result.tools) {
      catalog.cacheTools(parsedMsg.result.tools);
      // Replace with filtered list
      parsedMsg.result.tools = catalog.getFilteredTools();
    }

    // Inject bridge tools
    injectBridgeTools(parsedMsg);
    // Inject site param if multi-site mode
    if (isMultiSite) {
      injectSiteParam(parsedMsg, siteKeys, config.defaultSite);
    }
    sendToClient(JSON.stringify(parsedMsg));
    return;
  }

  // Normal response — forward
  sendToClient(rawLine || JSON.stringify(parsedMsg));
}

// ---------------------------------------------------------------------------
// MCP Resources — site discovery
// ---------------------------------------------------------------------------

function handleResourcesList(msg) {
  const resources = [];

  if (isMultiSite) {
    resources.push({
      uri: 'wp-abilities://sites',
      name: 'WordPress Sites',
      description: `Available WordPress sites: ${siteKeys.join(', ')}`,
      mimeType: 'application/json',
    });
  }

  sendToClient(JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    result: { resources },
  }));
}

function handleResourcesReadSites(msg) {
  const sitesInfo = {};
  for (const [key, site] of Object.entries(config.sites)) {
    sitesInfo[key] = {
      label: site.label || key,
      url: site.url || '',
      transport: site.transport,
      connected: pool.transports ? pool.transports.has(key) : false,
    };
    if (site.multisite) {
      sitesInfo[key].subsites = site.multisite;
    }
  }

  sendToClient(JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      contents: [{
        uri: 'wp-abilities://sites',
        mimeType: 'application/json',
        text: JSON.stringify(sitesInfo, null, 2),
      }]
    },
  }));
}

// ---------------------------------------------------------------------------
// Output to client
// ---------------------------------------------------------------------------

function sendToClient(data) {
  process.stdout.write(data + '\n');
}

// ---------------------------------------------------------------------------
// Startup — connect to default site
// ---------------------------------------------------------------------------

(async function main() {
  try {
    defaultTransport = await pool.connectDefault((parsedMsg, rawLine) => {
      handleTransportMessage(parsedMsg, rawLine);
    });
    log(`Default transport connected: ${config.defaultSite}`);
    drainEarlyQueue();
  } catch (err) {
    process.stderr.write(`wp-abilities-mcp: Failed to connect to default site: ${err.message}\n`);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

function shutdown() {
  log('Shutting down');
  pool.shutdownAll().then(() => {
    process.exit(0);
  }).catch(() => {
    process.exit(1);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});
