'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { sanitizeToolsList, isToolsListResponse } = require('../sanitizer');

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
    this.ready = false;
    this.onMessage = null;  // Callback: (parsedMsg, rawLine) => void

    // Message queue — serialized processing
    this.messageQueue = [];
    this.processing = false;

    // Healthcheck
    this.healthcheckTimer = null;

    // Retry config
    this.maxRetries = 3;
    this.baseRetryDelay = 1000;

    // Handshake cache for session recovery
    this.cachedInitRequest = null;
    this.cachedInitNotification = null;
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

  async _drainQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.messageQueue.length > 0) {
      const line = this.messageQueue.shift();
      await this._processMessage(line);
    }

    this.processing = false;
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

        // Sanitize tools/list responses
        if (isToolsListResponse(parsed)) {
          sanitizeToolsList(parsed);
        }

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

      // Session expired — re-handshake and retry
      if ((result.statusCode === 404 || result.statusCode === 410) && attempt === 0) {
        this.log('Session expired — attempting recovery');
        this.sessionId = null;
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
          // Capture session ID
          const newSessionId = res.headers['mcp-session-id'];
          if (newSessionId) {
            this.sessionId = newSessionId;
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
