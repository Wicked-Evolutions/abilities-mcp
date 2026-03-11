'use strict';

const { sanitizeToolsList, isToolsListResponse } = require('./sanitizer');
const { injectSiteParam, extractSiteParam } = require('./tool-injector');
const { isBridgeTool, injectBridgeTools } = require('./bridge-tools');

/**
 * McpRouter — routes MCP messages between client, transports, and bridge tools.
 *
 * Responsibilities:
 * - Route client messages to the correct transport
 * - Handle bridge tools locally (health, browse, load)
 * - Sanitize and enrich tools/list responses (annotations, site param, bridge tools)
 * - Handle resources/list and resources/read locally
 * - Route tools/call to the correct site transport
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
class McpRouter {

  /**
   * @param {object} opts
   * @param {object} opts.config        - Loaded config object
   * @param {string[]} opts.siteKeys    - All available site keys
   * @param {boolean} opts.isMultiSite  - Whether multi-site mode is active
   * @param {object} opts.pool          - ConnectionPool instance
   * @param {object} opts.catalog       - ToolCatalog instance
   * @param {function} opts.sendToClient - Function to send data to STDIO client
   * @param {function} opts.log         - Logger function
   */
  constructor(opts) {
    this.config = opts.config;
    this.siteKeys = opts.siteKeys;
    this.isMultiSite = opts.isMultiSite;
    this.pool = opts.pool;
    this.catalog = opts.catalog;
    this.sendToClient = opts.sendToClient;
    this.log = opts.log;

    // Handshake state
    this.cachedInitRequest = null;
    this.cachedInitNotification = null;
    this.clientProtocolVersion = null;
    this.initHandshakeComplete = false;

    // Default transport
    this.defaultTransport = null;

    // Early queue for messages before transport is ready
    this.MAX_EARLY_QUEUE = 50;
    this.earlyQueue = [];
  }

  /**
   * Set the default transport after connection.
   */
  setDefaultTransport(transport) {
    this.defaultTransport = transport;
  }

  /**
   * Drain messages queued before the default transport was ready.
   */
  drainEarlyQueue() {
    if (this.earlyQueue.length === 0) return;
    this.log(`Draining ${this.earlyQueue.length} early queued message(s)`);
    const queued = this.earlyQueue.slice();
    this.earlyQueue = [];
    for (const line of queued) {
      if (this.defaultTransport) this.defaultTransport.send(line);
    }
  }

  /**
   * Handle a parsed client message.
   * @param {object} msg - Parsed JSON-RPC message
   * @param {string} line - Raw JSON line
   */
  handleClientMessage(msg, line) {
    this.log(`CLIENT > BRIDGE: ${msg.method || 'response'} (id=${msg.id})`);

    // Cache initialize request
    if (msg.method === 'initialize') {
      this.cachedInitRequest = msg;
      if (msg.params && msg.params.protocolVersion) {
        this.clientProtocolVersion = msg.params.protocolVersion;
      }
      this._forwardToDefault(line);
      return;
    }

    // Cache initialized notification
    if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
      this.cachedInitNotification = msg;
      this.initHandshakeComplete = true;
      this.pool.setHandshakeCache(this.cachedInitRequest, this.cachedInitNotification, this.clientProtocolVersion);
      this._forwardToDefault(line);
      return;
    }

    // tools/list — route to default, then inject site param
    if (msg.method === 'tools/list') {
      this._forwardToDefault(line);
      return;
    }

    // tools/call — check for bridge tools first, then route
    if (msg.method === 'tools/call') {
      if (msg.params && isBridgeTool(msg.params.name)) {
        this._handleBridgeToolCall(msg);
        return;
      }
      this._handleToolsCall(msg);
      return;
    }

    // resources/list — handle locally
    if (msg.method === 'resources/list') {
      this._handleResourcesList(msg);
      return;
    }

    // resources/read — handle locally for our URIs
    if (msg.method === 'resources/read') {
      if (msg.params && msg.params.uri === 'wp-abilities://sites') {
        this._handleResourcesReadSites(msg);
        return;
      }
      this._forwardToDefault(line);
      return;
    }

    // Everything else — forward to default
    this._forwardToDefault(line);
  }

  /**
   * Handle a message received from any transport (default or non-default).
   * @param {object|null} parsedMsg - Parsed message or null
   * @param {string|null} rawLine - Raw line or null
   */
  handleTransportMessage(parsedMsg, rawLine) {
    if (!parsedMsg) {
      if (rawLine) this.log(`Non-JSON from transport (dropped): ${rawLine.substring(0, 200)}`);
      return;
    }

    // Sanitize tools/list responses
    if (isToolsListResponse(parsedMsg)) {
      sanitizeToolsList(parsedMsg, this.log);

      // Cache full tools list in catalog (before filtering)
      if (this.catalog.isEnabled() && parsedMsg.result && parsedMsg.result.tools) {
        this.catalog.cacheTools(parsedMsg.result.tools);
        parsedMsg.result.tools = this.catalog.getFilteredTools();
      }

      // Inject bridge tools
      injectBridgeTools(parsedMsg);
      // Inject site param if multi-site mode
      if (this.isMultiSite) {
        injectSiteParam(parsedMsg, this.siteKeys, this.config.defaultSite);
      }
      this.sendToClient(JSON.stringify(parsedMsg));
      return;
    }

    // Normal response — forward
    this.sendToClient(rawLine || JSON.stringify(parsedMsg));
  }

  // ---------------------------------------------------------------------------
  // Internal — forwarding
  // ---------------------------------------------------------------------------

  _forwardToDefault(line) {
    if (this.defaultTransport) {
      this.defaultTransport.send(line);
    } else {
      if (this.earlyQueue.length >= this.MAX_EARLY_QUEUE) {
        this.log('Early queue full — rejecting message');
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            this.sendToClient(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              error: { code: -32603, message: 'Server not ready — queue full' }
            }));
          }
        } catch (e) { /* non-JSON, drop */ }
        return;
      }
      this.earlyQueue.push(line);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — bridge tools
  // ---------------------------------------------------------------------------

  async _handleBridgeToolCall(msg) {
    const toolName = msg.params.name;
    const toolArgs = msg.params.arguments || {};

    if (toolName === 'wp_bridge_health') {
      const keysToCheck = toolArgs.site ? [toolArgs.site] : this.siteKeys;
      const lines = [];

      for (const key of keysToCheck) {
        try {
          const result = await this.pool.healthCheck(key);
          let line = `${key}: ${result.status} (${result.latencyMs}ms)`;
          if (result.error) line += ` — ${result.error}`;
          lines.push(line);
        } catch (err) {
          lines.push(`${key}: error — ${err.message}`);
        }
      }

      this.sendToClient(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: lines.join('\n') }] },
      }));
      return;
    }

    if (toolName === 'wp_browse_tools') {
      if (!this.catalog.isEnabled() || !this.catalog.fullTools) {
        this.sendToClient(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: 'Tool filtering is not enabled or tools have not been loaded yet.' }] },
        }));
        return;
      }

      const summary = this.catalog.getCategorySummary();
      const lines = summary.map(c =>
        `${c.active ? '[LOADED]' : '       '} ${c.name} (${c.toolCount} tools)`
      );
      lines.push('');
      lines.push(`Total: ${this.catalog.fullTools.length} tools in ${summary.length} categories`);
      lines.push(`Loaded: ${summary.filter(c => c.active).reduce((n, c) => n + c.toolCount, 0)} tools`);
      lines.push('');
      lines.push('Use wp_load_tools with categories array to activate.');

      this.sendToClient(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: lines.join('\n') }] },
      }));
      return;
    }

    if (toolName === 'wp_load_tools') {
      if (!this.catalog.isEnabled() || !this.catalog.fullTools) {
        this.sendToClient(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: 'Tool filtering is not enabled or tools have not been loaded yet.' }] },
        }));
        return;
      }

      const toActivate = toolArgs.categories || [];
      const toDeactivate = toolArgs.deactivate || [];

      if (toDeactivate.length > 0) {
        this.catalog.deactivateCategories(toDeactivate);
      }

      const activated = this.catalog.activateCategories(toActivate);
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

      const filtered = this.catalog.getFilteredTools();
      lines.push(`Tools now available: ${filtered.length}/${this.catalog.fullTools.length}`);

      this.sendToClient(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: lines.join('\n') }] },
      }));

      // Notify client that tools list has changed
      if (activated.length > 0 || toDeactivate.length > 0) {
        this.sendToClient(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
        }));
        this.log(`Sent tools/list_changed notification (activated: ${activated.join(',')})`);
      }
      return;
    }

    // Unknown bridge tool
    this.sendToClient(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32601, message: `Unknown bridge tool: ${toolName}` },
    }));
  }

  // ---------------------------------------------------------------------------
  // Internal — tools/call routing
  // ---------------------------------------------------------------------------

  async _handleToolsCall(msg) {
    const toolArgs = msg.params && msg.params.arguments ? msg.params.arguments : {};
    const { site, cleanArgs } = extractSiteParam(toolArgs, this.config.defaultSite);

    this.log(`tools/call: ${msg.params.name} → site=${site}`);

    const modifiedMsg = {
      ...msg,
      params: { ...msg.params, arguments: cleanArgs },
    };
    const modifiedLine = JSON.stringify(modifiedMsg);

    if (site === this.config.defaultSite) {
      this._forwardToDefault(modifiedLine);
      return;
    }

    try {
      const transport = await this.pool.getTransport(site);
      if (!transport.onMessage) {
        transport.onMessage = (parsedMsg, rawLine) => {
          this.handleTransportMessage(parsedMsg, rawLine);
        };
      }
      transport.send(modifiedLine);
    } catch (err) {
      this.log(`Route to site "${site}" failed: ${err.message}`);
      this.sendToClient(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32603, message: `Failed to connect to site "${site}": ${err.message}` }
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — resources
  // ---------------------------------------------------------------------------

  _handleResourcesList(msg) {
    const resources = [];

    if (this.isMultiSite) {
      resources.push({
        uri: 'wp-abilities://sites',
        name: 'WordPress Sites',
        description: `Available WordPress sites: ${this.siteKeys.join(', ')}`,
        mimeType: 'application/json',
      });
    }

    this.sendToClient(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { resources },
    }));
  }

  _handleResourcesReadSites(msg) {
    const sitesInfo = {};
    for (const [key, site] of Object.entries(this.config.sites)) {
      sitesInfo[key] = {
        label: site.label || key,
        url: site.url || '',
        transport: site.transport,
        connected: this.pool.transports ? this.pool.transports.has(key) : false,
      };
      if (site.multisite) {
        sitesInfo[key].subsites = site.multisite;
      }
    }

    this.sendToClient(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        contents: [{
          uri: 'wp-abilities://sites',
          mimeType: 'application/json',
          text: JSON.stringify(sitesInfo, null, 2),
        }]
      },
    }));
  }
}

module.exports = { McpRouter };
