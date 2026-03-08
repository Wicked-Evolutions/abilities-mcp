#!/usr/bin/env node
/**
 * wp-abilities-mcp v1.1.0
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
 * @version 1.1.0
 * @license GPL-2.0-or-later
 */

'use strict';

const { createLogger } = require('./lib/logger');
const { loadConfig, buildSiteKeyEnum } = require('./lib/config');
const { ConnectionPool } = require('./lib/connection-pool');
const { ToolCatalog } = require('./lib/tool-catalog');
const { McpRouter } = require('./lib/router');
const { SshTransport } = require('./lib/transports/ssh-transport');

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
log('wp-abilities-mcp v1.1.0 starting');

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

function sendToClient(data) {
  process.stdout.write(data + '\n');
}

const router = new McpRouter({
  config,
  siteKeys,
  isMultiSite,
  pool,
  catalog,
  sendToClient,
  log,
});

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
    if (line.trim()) {
      let msg;
      try {
        msg = JSON.parse(line.trim());
      } catch (e) {
        log(`Non-JSON from client (dropped): ${line.substring(0, 200)}`);
        continue;
      }
      router.handleClientMessage(msg, line.trim());
    }
  }
});

process.stdin.on('end', () => {
  log('Client stdin closed — shutting down');
  shutdown();
});

// ---------------------------------------------------------------------------
// Startup — connect to default site
// ---------------------------------------------------------------------------

(async function main() {
  try {
    const transport = await pool.connectDefault((parsedMsg, rawLine) => {
      router.handleTransportMessage(parsedMsg, rawLine);
    });
    router.setDefaultTransport(transport);
    log(`Default transport connected: ${config.defaultSite}`);
    router.drainEarlyQueue();
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
