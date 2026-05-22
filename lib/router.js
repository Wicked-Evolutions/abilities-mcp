'use strict';

const { sanitizeToolsList, isToolsListResponse } = require('./sanitizer');
const { injectSiteParam, extractSiteParam, applyAdapterToolSchemaOverlays } = require('./tool-injector');
const { isBridgeTool, injectBridgeTools } = require('./bridge-tools');
const { buildCategorySummaryFromTools } = require('./tool-catalog');

/**
 * McpRouter — routes MCP messages between client, transports, and bridge tools.
 *
 * Responsibilities:
 * - Route client messages to the correct transport
 * - Handle bridge tools locally (health, browse, load)
 * - Sanitize and enrich tools/list responses (annotations, site param, bridge tools)
 * - Forward resources/list to WordPress and inject bridge resources
 * - Handle resources/read locally for bridge URIs, forward others to WordPress
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

    // Track pending resources/list request IDs for response interception
    this.pendingResourcesListIds = new Set();

    // Default transport
    this.defaultTransport = null;

    // Early queue for messages before transport is ready
    this.MAX_EARLY_QUEUE = 50;
    this.earlyQueue = [];

    // Issue #76: degraded mode — entered when ALL configured sites fail to
    // connect at boot. The bridge still answers `initialize` with a locally
    // synthesized InitializeResult (so the MCP runtime stays connectable and
    // the operator can call wp_bridge_health to see which sites are degraded);
    // tools/list returns the bridge's three local tools only; non-bridge
    // tools/call surfaces a per-call error naming the degraded sites.
    this.degraded = false;
    this.degradedSites = [];  // [{ siteId, reason }]

    // Issue #87: sites that have failed the *re-forwarded cached initialize*
    // (not merely connect — OAuth connect() does not validate tokens). Used to
    // exclude already-failed sites from request-time fallback so the chain
    // strictly converges: when every configured site is in this map there is
    // no untried site left, and the #76 all-sites-down gate fires instead of
    // alternating between bad OAuth sites forever. siteId → failure reason.
    this._initFailedSites = new Map();

    // C1: in-flight isolated cross-site tools/list fetches, keyed by the
    // namespaced internal request id. handleTransportMessage resolves and
    // removes the matching entry BEFORE its normal sanitize/cache/forward path,
    // so an isolated response is never forwarded to the client and never cached
    // as the default catalog. id → { resolve, reject, timer }.
    this._isolatedFetches = new Map();
    this._isolatedFetchSeq = 0;
  }

  /**
   * Set the default transport after connection.
   */
  setDefaultTransport(transport) {
    this.defaultTransport = transport;
  }

  /**
   * Issue #76: enter degraded mode when no configured site connected at boot.
   * The router will synthesize an InitializeResult on the next `initialize`
   * request and refuse non-bridge tool calls with a descriptive error.
   *
   * @param {Array<{siteId:string, reason:string}>} degradedSites
   */
  enterDegradedMode(degradedSites) {
    this.degraded = true;
    this.degradedSites = Array.isArray(degradedSites) ? degradedSites.slice() : [];
    this.log(
      `Router entering degraded mode: ${this.degradedSites.length} site(s) failed to ` +
      `connect at boot — ` + this.degradedSites.map((s) => `${s.siteId} (${s.reason})`).join('; ')
    );
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
      // Issue #76: in degraded mode (no site transport at boot), synthesize
      // a locally-valid InitializeResult so the MCP runtime stays connectable
      // and the client can still issue wp_bridge_health / etc. against the
      // bridge's local tools.
      if (this.degraded) {
        this._sendSynthesizedInitializeResult(msg);
        return;
      }
      this._forwardToDefault(line);
      return;
    }

    // Cache initialized notification
    if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
      this.cachedInitNotification = msg;
      this.initHandshakeComplete = true;
      this.pool.setHandshakeCache(this.cachedInitRequest, this.cachedInitNotification, this.clientProtocolVersion);
      // In degraded mode there is no transport to forward to; the notification
      // is purely informational once the synthesized InitializeResult has been
      // sent.
      if (this.degraded) return;
      this._forwardToDefault(line);
      return;
    }

    // tools/list — route to default, then inject site param
    if (msg.method === 'tools/list') {
      // Issue #76: in degraded mode, return only the bridge's local tools so
      // operators can call wp_bridge_health and see which sites are degraded.
      if (this.degraded) {
        this._sendSynthesizedToolsListResult(msg);
        return;
      }
      this._forwardToDefault(line);
      return;
    }

    // tools/call — check for bridge tools first, then route
    if (msg.method === 'tools/call') {
      if (msg.params && isBridgeTool(msg.params.name)) {
        this._handleBridgeToolCall(msg);
        return;
      }
      // Issue #76: in degraded mode there is no backing site transport; surface
      // a per-call error naming the degraded sites so the client sees a clear
      // diagnostic, not a hang.
      if (this.degraded) {
        this._sendDegradedToolsCallError(msg);
        return;
      }
      this._handleToolsCall(msg);
      return;
    }

    // resources/list — forward to WordPress, inject bridge resources on response
    if (msg.method === 'resources/list') {
      if (msg.id !== undefined) {
        this.pendingResourcesListIds.add(msg.id);
      }
      this._forwardToDefault(line);
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

    // C1: isolated cross-site fetch correlation. If this response's id matches
    // an in-flight isolated tools/list fetch, resolve that fetch's promise and
    // STOP — the response must never reach the sanitize/cache/forward path
    // below (it is read-only and belongs to a non-default site; forwarding it
    // would corrupt the client's tool list and caching it would overwrite the
    // default-site catalog). Checked first, before any other handling.
    if (parsedMsg.id !== undefined && this._isolatedFetches.has(parsedMsg.id)) {
      const pending = this._isolatedFetches.get(parsedMsg.id);
      this._isolatedFetches.delete(parsedMsg.id);
      clearTimeout(pending.timer);
      pending.resolve(parsedMsg);
      return;
    }

    // Issue #76 follow-up — request-time boundary.
    //
    // OAuthHttpTransport.connect() does NOT pre-validate tokens (lib/transports/
    // oauth-http-transport.js:139-143 — sets ready=true, returns). When the
    // configured default site has an expired refresh token, _createTransport
    // and connect() both succeed; the bridge does NOT enter the connect-time
    // degraded path covered by #81. Instead, drainEarlyQueue() forwards the
    // cached `initialize` request through the transport, _processMessage
    // calls _postWithRetry → getAccessToken → refresh → throws RefreshError
    // synchronously when authStatus===EXPIRED (lib/auth/token-manager.js:147).
    // _processMessage catches the throw at lib/transports/oauth-http-transport.js:
    // 379-388 and emits onMessage with `{jsonrpc, id, error}` — the cached
    // initialize id paired with `OAuth HTTP bridge error: …`. Without this
    // intercept, the error→CallToolResult conversion below blanket-converts
    // it to `{result:{content:[],isError:true}}` and the MCP runtime rejects
    // the response shape. Pin the gate-violating shape here: when the failed
    // response carries the cached initialize id, synthesize a valid
    // InitializeResult locally and enter degraded mode for the failed site.
    if (parsedMsg.error && parsedMsg.id !== undefined &&
        this.cachedInitRequest && parsedMsg.id === this.cachedInitRequest.id) {
      const failedSite = this.config && this.config.defaultSite;
      const reason = (parsedMsg.error && parsedMsg.error.message) || 'unknown';
      this.log(
        `Initialize forward failed for "${failedSite || '(unknown)'}": ${reason} — ` +
        `attempting per-site fallback before degrading (Issue #87 S1/S2)`
      );
      // Issue #87 (S1/S2): a single (default) site's request-time refresh
      // failure must NOT blanket-degrade the whole bridge. Mirror the boot
      // path's per-site fallback; degrade only when no site can serve (the
      // genuine "all sites failed" condition the #76 gate is about). Async,
      // fire-and-forget like _handleToolsCall; the promise is exposed for
      // deterministic test sequencing.
      this._initFailurePromise = this._handleInitializeForwardFailure(failedSite, reason);
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

      // Apply schema overlays for known adapter tools whose filter / pagination
      // params do not always reach AI clients through the adapter's projection
      // (issue #97 + adapter #128). Additive — adapter wins on any collision.
      applyAdapterToolSchemaOverlays(parsedMsg);

      // Inject bridge tools
      injectBridgeTools(parsedMsg);
      // Inject site param if multi-site mode
      if (this.isMultiSite) {
        injectSiteParam(parsedMsg, this.siteKeys, this.config.defaultSite);
      }
      this.sendToClient(JSON.stringify(parsedMsg));
      return;
    }

    // Inject bridge resources into resources/list responses
    if (parsedMsg.id !== undefined && this.pendingResourcesListIds.has(parsedMsg.id)) {
      this.pendingResourcesListIds.delete(parsedMsg.id);
      if (!parsedMsg.error) {
        this._injectBridgeResources(parsedMsg);
      }
      this.sendToClient(JSON.stringify(parsedMsg));
      return;
    }

    // Detect execute-ability error responses and convert to isError format
    if (parsedMsg.result && parsedMsg.result.content) {
      const content = parsedMsg.result.content;
      if (Array.isArray(content) && content.length === 1 && content[0].type === 'text') {
        try {
          const payload = JSON.parse(content[0].text);
          if (payload.success === false && payload.error) {
            const errorParts = [];
            if (payload.error_code) errorParts.push(`[${payload.error_code}]`);
            errorParts.push(payload.error);
            if (payload.error_data) errorParts.push(`Details: ${JSON.stringify(payload.error_data)}`);

            parsedMsg.result.content[0].text = errorParts.join(' ');
            parsedMsg.result.isError = true;

            this.log(`Converted execute-ability error: ${errorParts.join(' ')}`);
            this.sendToClient(JSON.stringify(parsedMsg));
            return;
          }
        } catch { /* not JSON — pass through */ }
      }
    }

    // Convert JSON-RPC error objects to isError result format for client visibility
    if (parsedMsg.error && parsedMsg.id !== undefined) {
      const errMsg = parsedMsg.error.message || 'Unknown error';
      const errCode = parsedMsg.error.code || -32603;
      const converted = {
        jsonrpc: '2.0',
        id: parsedMsg.id,
        result: {
          content: [{ type: 'text', text: `[${errCode}] ${errMsg}` }],
          isError: true,
        },
      };
      this.log(`Converted JSON-RPC error to isError: [${errCode}] ${errMsg}`);
      this.sendToClient(JSON.stringify(converted));
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
      return;
    }
    // Issue #76: in degraded mode any message that reached this point (i.e.
    // not handled by a degraded-aware branch above) gets a per-call error
    // rather than being queued forever waiting for a transport that will
    // never arrive.
    if (this.degraded) {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          this.sendToClient(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: {
              code: -32603,
              message: `Bridge running in degraded mode — no site transport available. ` +
                this._degradedSummary(),
            },
          }));
        }
      } catch (e) { /* non-JSON, drop */ }
      return;
    }
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

  // ---------------------------------------------------------------------------
  // Internal — degraded mode (Issue #76) + request-time fallback (Issue #87)
  // ---------------------------------------------------------------------------

  /**
   * Issue #87 (S1/S2): the cached `initialize` forward failed for the runtime
   * default site (request-time refresh-token expiry). Try a fallback site that
   * has NOT already failed the cached initialize and re-forward the cached
   * initialize through it so the client gets a real InitializeResult and the
   * tool catalog populates normally — the bridge stays healthy and the failed
   * site is marked degraded (visible via wp_bridge_health).
   *
   * Convergence (reviewer blocker, PR #88): OAuth `transport.connect()` does
   * NOT validate refresh tokens, so a freshly-connected fallback can itself
   * fail the re-forwarded initialize. Without bookkeeping, two bad-token OAuth
   * sites alternate forever and the #76 gate never fires. We accumulate every
   * site that has failed the *cached initialize* in `this._initFailedSites`
   * and exclude all of them from the next fallback. Each round adds the
   * just-failed runtime default to that set, so the candidate pool strictly
   * shrinks; once every configured site has failed the initialize there is no
   * untried site left and the #76 all-sites-down gate fires (synthesized
   * InitializeResult + degraded mode). Termination is guaranteed.
   *
   * @param {string} failedSite  Runtime default site whose initialize failed.
   * @param {string} reason      Error message from the failed forward.
   */
  async _handleInitializeForwardFailure(failedSite, reason) {
    if (failedSite) this._initFailedSites.set(failedSite, reason);

    let fallback = null;
    try {
      fallback = await this.pool.connectFallback(
        Array.from(this._initFailedSites.keys()),
        (parsedMsg, rawLine) => {
          this.handleTransportMessage(parsedMsg, rawLine);
        }
      );
    } catch (err) {
      this.log(`Per-site fallback connect threw: ${err.message}`);
      fallback = null;
    }

    if (fallback) {
      this.setDefaultTransport(fallback);
      this.log(
        `Per-site fallback succeeded; re-forwarding cached initialize via ` +
        `"${this.config.defaultSite}" (excluded: ` +
        `${Array.from(this._initFailedSites.keys()).join(', ')}). ` +
        `Bridge NOT degraded (Issue #87 S1).`
      );
      this._forwardToDefault(JSON.stringify(this.cachedInitRequest));
      return;
    }

    // No untried site — every configured site has failed the cached
    // initialize (or connect). Genuine all-sites-down: preserve the #76 gate
    // — synthesize a valid InitializeResult locally and enter degraded mode so
    // the MCP runtime stays connectable and wp_bridge_health can report
    // per-site status. degradedSites carries the recorded per-site initialize
    // failure reason; sites that only failed connect fall back to their
    // in-memory `_degraded_reason`.
    this.log(
      `No untried fallback site — every configured site failed the cached ` +
      `initialize. Entering degraded mode (all sites failed, #76 gate).`
    );
    const degradedSites = Object.entries((this.config && this.config.sites) || {}).map(
      ([siteId, site]) => ({
        siteId,
        reason: this._initFailedSites.get(siteId) ||
          (site && site._degraded_reason) || 'connect failed',
      })
    );
    if (degradedSites.length === 0) {
      degradedSites.push({ siteId: failedSite || '(unknown)', reason });
    }
    this._sendSynthesizedInitializeResult(this.cachedInitRequest);
    this.enterDegradedMode(degradedSites);
  }

  // ---------------------------------------------------------------------------
  // Internal — degraded mode (Issue #76)
  // ---------------------------------------------------------------------------

  /**
   * Synthesize a valid MCP InitializeResult so the client's MCP validator
   * receives `protocolVersion`, `capabilities`, and `serverInfo` instead of
   * EOF (the failure mode pinned in #76 — bridge died before any response).
   *
   * Echoes the client's `protocolVersion` when present (per MCP spec — the
   * server returns the negotiated version, defaulting to its own when no
   * client-side version was provided).
   */
  _sendSynthesizedInitializeResult(msg) {
    const clientProtocol = msg.params && msg.params.protocolVersion;
    const result = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: clientProtocol || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: 'abilities-mcp (degraded)',
          version: this._bridgeVersion(),
        },
      },
    };
    this.sendToClient(JSON.stringify(result));
  }

  /**
   * Synthesize a tools/list response with only the bridge's local tools.
   * In degraded mode there is no WordPress adapter to answer the real list,
   * so wp_bridge_health / wp_browse_tools / wp_load_tools are still callable
   * for diagnostics.
   */
  _sendSynthesizedToolsListResult(msg) {
    const result = { jsonrpc: '2.0', id: msg.id, result: { tools: [] } };
    injectBridgeTools(result);
    this.sendToClient(JSON.stringify(result));
  }

  _sendDegradedToolsCallError(msg) {
    this.sendToClient(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: {
        code: -32603,
        message: `Tool call cannot be served — bridge is running in degraded mode. ` +
          this._degradedSummary() +
          ` Run: abilities-mcp reauth <site> to recover, or use the bridge tools ` +
          `(wp_bridge_health, wp_browse_tools, wp_load_tools) for diagnostics.`,
      },
    }));
  }

  _degradedSummary() {
    if (!this.degradedSites || this.degradedSites.length === 0) {
      return 'No degraded-site details available.';
    }
    const parts = this.degradedSites.map((s) => `${s.siteId}: ${s.reason}`);
    return `Degraded sites — ${parts.join('; ')}.`;
  }

  _bridgeVersion() {
    try {
      const pkg = require('../package.json');
      return (pkg && pkg.version) || 'unknown';
    } catch { return 'unknown'; }
  }

  // ---------------------------------------------------------------------------
  // Internal — isolated cross-site fetch (C1)
  // ---------------------------------------------------------------------------

  /**
   * Fetch a non-default site's tools/list in isolation — for read-only
   * cross-site browsing only.
   *
   * The response is correlated INTERNALLY by a namespaced request id and
   * resolved at the top of handleTransportMessage, so it is never forwarded to
   * the client and never cached as the default catalog. The namespaced id
   * (`bridge-xsite-tools-list-<n>`) cannot collide with the MCP client's
   * integer ids or the cached initialize id.
   *
   * @param {string} site - Non-default site key (may be a multisite composite).
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=10000]
   * @returns {Promise<object>} The raw tools/list JSON-RPC response message.
   */
  async _fetchSiteToolsListIsolated(site, opts = {}) {
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000;

    const transport = await this.pool.getTransport(site);
    // Wire the shared per-site message router if this transport is fresh, the
    // same way _handleToolsCall does — our isolated-fetch interception sits at
    // the top of handleTransportMessage, so the shared callback is correct.
    if (!transport.onMessage) {
      transport.onMessage = (parsedMsg, rawLine) => {
        this.handleTransportMessage(parsedMsg, rawLine);
      };
    }

    const id = `bridge-xsite-tools-list-${++this._isolatedFetchSeq}`;
    const requestLine = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._isolatedFetches.delete(id);
        reject(new Error(`Timed out fetching tools/list from site "${site}"`));
      }, timeoutMs);

      this._isolatedFetches.set(id, { resolve, reject, timer });

      try {
        transport.send(requestLine);
      } catch (err) {
        this._isolatedFetches.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
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
      const requestedSite = toolArgs.site;
      const isDefaultSite = !requestedSite || requestedSite === this.config.defaultSite;

      // ── Cross-site read-only browse (C1) ──────────────────────────────────
      // site !== defaultSite: fetch THAT site's catalog in isolation and report
      // a read-only category summary. The global ToolCatalog (scoped to the
      // connected default site) is never read, written, or mutated here, and
      // activeCategories is never touched.
      if (!isDefaultSite) {
        if (!this.siteKeys.includes(requestedSite)) {
          this.sendToClient(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text:
              `Unknown site "${requestedSite}". Available sites: ${this.siteKeys.join(', ')}.` }] },
          }));
          return;
        }

        let resp;
        try {
          resp = await this._fetchSiteToolsListIsolated(requestedSite);
        } catch (err) {
          this.sendToClient(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text:
              `Could not browse site "${requestedSite}": ${err.message}` }] },
          }));
          return;
        }

        const tools = (resp.result && Array.isArray(resp.result.tools)) ? resp.result.tools : [];
        const summary = buildCategorySummaryFromTools(tools);
        const lines = [];
        lines.push(
          `Scope: read-only catalog scoped to "${requestedSite}" (a non-default site). ` +
            `This is a browse-only view — these tools are NOT loaded into the MCP tools/list.`
        );
        lines.push('');
        for (const c of summary) {
          lines.push(`        ${c.name} (${c.toolCount} tools)`);
        }
        lines.push('');
        lines.push(`Total: ${tools.length} tools in ${summary.length} categories on "${requestedSite}".`);
        lines.push('');
        lines.push(
          `Direct-tool loading (wp_load_tools) applies only to the connected default site ` +
            `("${this.config.defaultSite}"). To call abilities on "${requestedSite}", use ` +
            `mcp-adapter-discover-abilities { site: "${requestedSite}", category } and ` +
            `mcp-adapter-execute-ability { site: "${requestedSite}", ability_name, parameters }.`
        );

        this.sendToClient(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: lines.join('\n') }] },
        }));
        return;
      }

      // ── Default-site browse (unchanged) ───────────────────────────────────
      if (!this.catalog.isEnabled() || !this.catalog.fullTools) {
        this.sendToClient(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: 'Tool filtering is not enabled or tools have not been loaded yet.' }] },
        }));
        return;
      }

      const summary = this.catalog.getCategorySummary();
      const lines = [];
      lines.push(
        `Scope: direct-tool catalog scoped to defaultSite (${this.config.defaultSite}). ` +
          `Not full cross-site ability discovery.`
      );
      lines.push('');
      for (const c of summary) {
        lines.push(`${c.active ? '[LOADED]' : '       '} ${c.name} (${c.toolCount} tools)`);
      }
      lines.push('');
      lines.push(`Total: ${this.catalog.fullTools.length} tools in ${summary.length} categories`);
      lines.push(`Loaded: ${summary.filter(c => c.active).reduce((n, c) => n + c.toolCount, 0)} tools`);
      lines.push('');
      lines.push('Use wp_load_tools with categories array to activate.');
      lines.push('');
      lines.push(
        'For abilities on another site, or in a category not listed here, use ' +
          'mcp-adapter-discover-abilities { site, category } and ' +
          'mcp-adapter-execute-ability { site, ability_name, parameters }.'
      );

      this.sendToClient(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: lines.join('\n') }] },
      }));
      return;
    }

    if (toolName === 'wp_load_tools') {
      const requestedSite = toolArgs.site;
      const isDefaultSite = !requestedSite || requestedSite === this.config.defaultSite;

      // ── Cross-site load is not supported (C1; per C2 it is out of scope) ───
      // site !== defaultSite: activate NOTHING. A single MCP tools/list cannot
      // represent per-site loaded tools without a naming/activation/collision
      // redesign (C2). Return guidance pointing at the adapter meta-tools, which
      // are the supported cross-site execution path. activeCategories untouched.
      if (!isDefaultSite) {
        const lines = [
          `Direct-tool loading applies only to the connected default site ("${this.config.defaultSite}").`,
          `Nothing was activated for "${requestedSite}".`,
          '',
          `To use abilities on "${requestedSite}", call them through the adapter meta-tools:`,
          `  mcp-adapter-discover-abilities { site: "${requestedSite}", category: "<category>" }`,
          `  mcp-adapter-execute-ability { site: "${requestedSite}", ability_name: "<ability>", parameters: { ... } }`,
          '',
          `To browse what "${requestedSite}" offers without loading, use ` +
            `wp_browse_tools { site: "${requestedSite}" }.`,
        ];
        this.sendToClient(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: lines.join('\n') }] },
        }));
        return;
      }

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
      const missing = toActivate.filter((c) => !this.catalog.categories[c]);
      const lines = [];

      if (activated.length > 0) {
        lines.push(`Activated: ${activated.join(', ')}`);
      }
      if (toDeactivate.length > 0) {
        lines.push(`Deactivated: ${toDeactivate.join(', ')}`);
      }
      if (missing.length > 0) {
        lines.push(
          `Not in the direct-tool catalog (scoped to defaultSite "${this.config.defaultSite}"): ` +
            missing.join(', ') +
            '.'
        );
        lines.push(
          'For abilities on another site, or in a category not in this catalog, use the ' +
            'adapter meta-tools instead:'
        );
        for (const cat of missing) {
          lines.push(`  mcp-adapter-discover-abilities { site: "<site>", category: "${cat}" }`);
        }
        lines.push(
          '  mcp-adapter-execute-ability { site: "<site>", ability_name: "<ability>", parameters: { ... } }'
        );
      }
      if (activated.length === 0 && toDeactivate.length === 0 && missing.length === 0) {
        lines.push('No changes — categories may already be active.');
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

  /**
   * Inject bridge-owned resources into a resources/list response from WordPress.
   * @param {object} msg - Parsed JSON-RPC response
   */
  _injectBridgeResources(msg) {
    // Ensure result.resources array exists (WordPress may return empty or error)
    if (!msg.result) msg.result = {};
    if (!Array.isArray(msg.result.resources)) msg.result.resources = [];

    if (this.isMultiSite) {
      msg.result.resources.push({
        uri: 'wp-abilities://sites',
        name: 'WordPress Sites',
        description: `Available WordPress sites: ${this.siteKeys.join(', ')}`,
        mimeType: 'application/json',
      });
    }
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
