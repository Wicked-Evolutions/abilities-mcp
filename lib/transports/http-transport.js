'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const MAX_QUEUE = 100;

/**
 * HTTP Transport — connects to WordPress abilities via HTTP POST.
 *
 * Translates MCP STDIO ↔ HTTP POST with Basic Auth and session management.
 * Enhancements over mcp-http-bridge v1.0.0:
 *   - Retry with exponential backoff on network error / 5xx
 *   - Session recovery on 404/410 (re-handshake)
 *   - Healthcheck ping every 45s
 *   - Tool sanitization via shared sanitizer
 *
 * @param {object} opts
 * @param {string} opts.endpoint   - Full URL to the MCP endpoint
 * @param {string} opts.username   - WordPress username
 * @param {string} opts.password   - Application Password
 * @param {function} opts.logger   - Logger function
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
class HttpTransport {

  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.username = opts.username;
    this.password = opts.password;
    this.log = opts.logger || function noop() {};

    const parsedUrl = new URL(this.endpoint);
    this.parsedUrl = parsedUrl;
    this.isHttps = parsedUrl.protocol === 'https:';
    this.httpModule = this.isHttps ? https : http;
    this.authHeader = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');

    // State
    this.sessionId = null;
    this.sessionToken = null; // Mcp-Session-Token (HMAC, echoed back on every request)
    this.clientProtocolVersion = null; // Captured from initialize request for version rewriting
    this.ready = false;
    this.onMessage = null;  // Callback: (parsedMsg, rawLine) => void

    // Message queue — serialized processing
    this.messageQueue = [];
    this.processing = false;

    // Batch coalescing — accumulate messages within a short window before dispatch
    this._coalesceTimer = null;
    this._coalesceWindowMs = 10;

    // Healthcheck
    this.healthcheckTimer = null;

    // Retry config
    this.maxRetries = 3;
    this.baseRetryDelay = 1000;

    // Handshake cache for session recovery
    this.cachedInitRequest = null;
    this.cachedInitNotification = null;

    // Cookie jar — per-host, scoped to this transport instance so multi-site
    // doesn't bleed cookies across sites. Keys are hostnames.
    this._cookies = new Map(); // hostname -> Map<name, value>
  }

  /**
   * Connect — for HTTP transport this just marks ready and starts healthcheck.
   * The actual connection happens on first request.
   */
  async connect() {
    this.ready = true;
    this.log(`HTTP transport ready: ${this.parsedUrl.hostname}`);
    this._startHealthcheck();
  }

  /**
   * Send a line (JSON string) to the remote WordPress site.
   */
  send(line) {
    if (this.messageQueue.length >= MAX_QUEUE) {
      this.log('HTTP queue full — rejecting');
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.onMessage) {
          this.onMessage({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32603, message: 'HTTP transport queue full' }
          }, null);
        }
      } catch (e) { /* ignore */ }
      return;
    }
    this.messageQueue.push(line);
    this._drainQueue();
  }

  /**
   * Check if transport is ready.
   */
  isReady() {
    return this.ready;
  }

  /**
   * Perform MCP handshake (initialize + initialized).
   * Used by connection pool for lazy-connected transports.
   */
  async performHandshake(initRequest, initNotification) {
    this.cachedInitRequest = initRequest;
    this.cachedInitNotification = initNotification;

    // Capture client protocol version for rewriting
    if (initRequest.params && initRequest.params.protocolVersion) {
      this.clientProtocolVersion = initRequest.params.protocolVersion;
    }

    // Send initialize request
    const initLine = JSON.stringify(initRequest);
    const initResult = await this._postWithRetry(initLine);
    if (initResult && initResult.body && initResult.body.trim()) {
      // Parse and forward the init response (but don't send to client — pool handles this)
      this.log(`HTTP handshake init response: ${initResult.statusCode}`);
    }

    // Capture session ID from init
    if (initResult && initResult.sessionId) {
      this.sessionId = initResult.sessionId;
    }

    // Send initialized notification
    if (initNotification) {
      const notifLine = JSON.stringify(initNotification);
      await this._postWithRetry(notifLine);
    }
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    this._stopHealthcheck();
    this.ready = false;
    this.log(`HTTP transport shutdown: ${this.parsedUrl.hostname}`);
  }

  // ---------------------------------------------------------------------------
  // Internal — message queue
  // ---------------------------------------------------------------------------

  _drainQueue() {
    // If already draining or a coalesce timer is pending, nothing to do —
    // the in-progress drain or the pending timer will pick up new arrivals.
    if (this.processing || this._coalesceTimer) return;

    this._coalesceTimer = setTimeout(async () => {
      this._coalesceTimer = null;
      if (this.processing || this.messageQueue.length === 0) return;

      this.processing = true;

      // Snapshot all pending messages in one batch.
      const batch = this.messageQueue.splice(0);

      if (batch.length === 1) {
        // Single message — use normal path (no batch overhead).
        await this._processMessage(batch[0]);
      } else {
        // Multiple messages — coalesce into a JSON-RPC batch POST.
        await this._processBatch(batch);
      }

      this.processing = false;

      // If more messages arrived while we were processing, schedule another drain.
      if (this.messageQueue.length > 0) {
        this._drainQueue();
      }
    }, this._coalesceWindowMs);
  }

  /**
   * Send multiple messages as a JSON-RPC batch array in a single HTTP POST.
   * Routes responses back to callers by matching on `id`.
   *
   * @param {string[]} lines - Array of raw JSON strings.
   */
  async _processBatch(lines) {
    // Parse all messages. Invalid JSON falls back to individual processing.
    const parsed = [];
    const fallback = [];
    for (const line of lines) {
      try {
        parsed.push({ line, msg: JSON.parse(line) });
      } catch {
        fallback.push(line);
      }
    }

    // Cache handshake messages (same as _processMessage).
    for (const { msg } of parsed) {
      if (msg.method === 'initialize') {
        this.cachedInitRequest = msg;
        if (msg.params && msg.params.protocolVersion) {
          this.clientProtocolVersion = msg.params.protocolVersion;
        }
      }
      if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
        this.cachedInitNotification = msg;
      }
    }

    // Separate notifications (no id) from requests — notifications don't get responses.
    const requests = parsed.filter(({ msg }) => 'id' in msg);
    const notifications = parsed.filter(({ msg }) => !('id' in msg));

    // Send notifications individually (they expect no response, keep things clean).
    for (const { line } of notifications) {
      try { await this._postWithRetry(line); } catch { /* ignore notification errors */ }
    }

    // If no actual requests, nothing more to do.
    if (requests.length === 0) {
      for (const line of fallback) await this._processMessage(line);
      return;
    }

    // Build the batch array body.
    const batchBody = JSON.stringify(requests.map(({ msg }) => msg));

    // Build an id→resolve map so we can route responses back.
    const pending = new Map();
    const resultPromises = requests.map(({ msg }) => {
      return new Promise((resolve) => { pending.set(String(msg.id), resolve); });
    });

    try {
      const result = await this._postWithRetry(batchBody);

      if (result.body && result.body.trim()) {
        let batchResponse;
        try {
          batchResponse = JSON.parse(result.body.trim());
        } catch {
          // Unparseable — forward raw to all callers as error.
          for (const { msg } of requests) {
            pending.get(String(msg.id))?.({
              jsonrpc: '2.0', id: msg.id,
              error: { code: -32700, message: 'Batch response parse error' },
            });
          }
          return;
        }

        // PHP returns an array of results — route each back by id.
        if (Array.isArray(batchResponse)) {
          for (let resp of batchResponse) {
            // Protocol version negotiation is handled server-side (InitializeHandler v1.0.7+).
            const resolver = pending.get(String(resp.id));
            if (resolver) {
              resolver(resp);
              pending.delete(String(resp.id));
            }
          }
        } else {
          // Single-object response (shouldn't happen for batch, but guard it).
          const resp = batchResponse;
          // Protocol version negotiation is handled server-side (InitializeHandler v1.0.7+).
          const resolver = pending.get(String(resp.id));
          if (resolver) {
            resolver(resp);
            pending.delete(String(resp.id));
          }
        }
      }
    } catch (err) {
      this.log(`HTTP batch error: ${err.message}`);
      // Resolve all pending with an error.
      for (const { msg } of requests) {
        pending.get(String(msg.id))?.({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32000, message: `HTTP batch error: ${err.message}` },
        });
      }
    }

    // Any requests that didn't get a response — resolve with error.
    for (const [id, resolve] of pending.entries()) {
      resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: 'No response in batch' } });
    }

    // Forward all resolved responses to the message callback.
    const responses = await Promise.all(resultPromises);
    for (const resp of responses) {
      if (this.onMessage) this.onMessage(resp, JSON.stringify(resp));
    }

    // Process any fallback (parse-failed) messages individually.
    for (const line of fallback) {
      await this._processMessage(line);
    }
  }

  async _processMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not JSON — send error response
      if (this.onMessage) {
        this.onMessage({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }, null);
      }
      return;
    }

    // Cache handshake messages for session recovery
    if (msg.method === 'initialize') {
      this.cachedInitRequest = msg;
      if (msg.params && msg.params.protocolVersion) {
        this.clientProtocolVersion = msg.params.protocolVersion;
      }
    }
    if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
      this.cachedInitNotification = msg;
    }

    const isNotification = msg.method && !('id' in msg);

    try {
      const result = await this._postWithRetry(line);

      if (result.body && result.body.trim()) {
        const rawLine = result.body.trim();
        let parsed;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          // Non-JSON response — forward raw
          if (this.onMessage) this.onMessage(null, rawLine);
          return;
        }

        // Protocol version negotiation is handled server-side (InitializeHandler v1.0.7+).

        // Fold _metadata.input_schema into error text content for client visibility
        if (parsed.result && parsed.result.isError && parsed.result._metadata && parsed.result._metadata.input_schema) {
          const content = parsed.result.content;
          if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
            const schema = parsed.result._metadata.input_schema;
            const required = schema.required || [];
            const props = schema.properties || {};
            const paramList = Object.entries(props).map(([k, v]) => {
              const req = required.includes(k) ? ' (required)' : '';
              return `  ${k}: ${v.type || 'any'}${req} — ${v.description || ''}`;
            }).join('\n');
            content[0].text += `\n\nExpected parameters:\n${paramList}`;
          }
        }

        // Sanitization is handled by the router (McpRouter.handleTransportMessage)
        // to avoid double-sanitization. Transport just forwards the parsed message.

        if (this.onMessage) this.onMessage(parsed, JSON.stringify(parsed));
      }
    } catch (err) {
      this.log(`HTTP error for ${msg.method || 'unknown'}: ${err.message}`);

      // Only send error response for requests (not notifications)
      if (!isNotification && this.onMessage) {
        this.onMessage({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `HTTP bridge error: ${err.message}` },
        }, null);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — HTTP POST with retry
  // ---------------------------------------------------------------------------

  async _postWithRetry(body, attempt = 0) {
    try {
      const result = await this._post(body);

      // Session expired — re-handshake and retry.
      // 404/410: explicit session-not-found signals.
      // 401/403: some WordPress configs return these for stale session tokens,
      //          but only treat as expiry if we had an active session — otherwise
      //          it's a genuine auth failure (wrong credentials, capability denied).
      const isExplicitExpiry = result.statusCode === 404 || result.statusCode === 410;
      const isStaleSession = (result.statusCode === 401 || result.statusCode === 403) && this.sessionId !== null;
      if ((isExplicitExpiry || isStaleSession) && attempt === 0) {
        this.log(`Session expired (HTTP ${result.statusCode}) — attempting recovery`);
        this.sessionId = null;
        this.sessionToken = null;
        if (this.cachedInitRequest) {
          await this.performHandshake(this.cachedInitRequest, this.cachedInitNotification);
          return this._postWithRetry(body, attempt + 1);
        }
      }

      // 5xx — retry with backoff
      if (result.statusCode >= 500 && attempt < this.maxRetries) {
        const delay = this.baseRetryDelay * Math.pow(2, attempt);
        this.log(`HTTP ${result.statusCode} — retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
        await this._sleep(delay);
        return this._postWithRetry(body, attempt + 1);
      }

      return result;
    } catch (err) {
      // Network error — retry with backoff
      if (attempt < this.maxRetries) {
        const delay = this.baseRetryDelay * Math.pow(2, attempt);
        this.log(`Network error — retrying in ${delay}ms: ${err.message}`);
        await this._sleep(delay);
        return this._postWithRetry(body, attempt + 1);
      }
      throw err;
    }
  }

  _post(body) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader,
        'Accept': 'application/json',
      };

      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }
      if (this.sessionToken) {
        headers['Mcp-Session-Token'] = this.sessionToken;
      }

      // Send cookies for this host
      const hostCookies = this._cookies.get(this.parsedUrl.hostname);
      if (hostCookies && hostCookies.size > 0) {
        headers['Cookie'] = Array.from(hostCookies.entries())
          .map(([name, value]) => `${name}=${value}`)
          .join('; ');
      }

      const options = {
        hostname: this.parsedUrl.hostname,
        port: this.parsedUrl.port || (this.isHttps ? 443 : 80),
        path: this.parsedUrl.pathname + this.parsedUrl.search,
        method: 'POST',
        headers,
      };

      const req = this.httpModule.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          // Capture session ID and token from response headers.
          const newSessionId = res.headers['mcp-session-id'];
          if (newSessionId) {
            this.sessionId = newSessionId;
          }
          const newSessionToken = res.headers['mcp-session-token'];
          if (newSessionToken) {
            this.sessionToken = newSessionToken;
          }

          // Parse Set-Cookie headers and store in cookie jar
          const setCookieHeader = res.headers['set-cookie'];
          if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            if (!this._cookies.has(this.parsedUrl.hostname)) {
              this._cookies.set(this.parsedUrl.hostname, new Map());
            }
            const jar = this._cookies.get(this.parsedUrl.hostname);
            for (const raw of cookies) {
              // Only store name=value — strip attributes (Path, HttpOnly, etc.)
              const nameValue = raw.split(';')[0].trim();
              const eqIdx = nameValue.indexOf('=');
              if (eqIdx > 0) {
                jar.set(nameValue.slice(0, eqIdx), nameValue.slice(eqIdx + 1));
              }
            }
          }

          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            sessionId: newSessionId || this.sessionId,
          });
        });
      });

      req.on('error', (err) => reject(err));
      req.setTimeout(120000, () => {
        req.destroy(new Error('Request timeout (120s)'));
      });

      req.write(body);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — healthcheck
  // ---------------------------------------------------------------------------

  _startHealthcheck() {
    this._stopHealthcheck();
    this.healthcheckTimer = setInterval(() => {
      this._sendPing();
    }, 45000);
    // Unref so it doesn't keep the process alive
    if (this.healthcheckTimer.unref) this.healthcheckTimer.unref();
  }

  _stopHealthcheck() {
    if (this.healthcheckTimer) {
      clearInterval(this.healthcheckTimer);
      this.healthcheckTimer = null;
    }
  }

  _sendPing() {
    const pingMsg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'ping',
      id: `__healthcheck_${Date.now()}`,
    });

    this._post(pingMsg).then((result) => {
      this.log(`HTTP healthcheck: ${result.statusCode}`);
    }).catch((err) => {
      this.log(`HTTP healthcheck failed: ${err.message}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — utils
  // ---------------------------------------------------------------------------

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { HttpTransport };
