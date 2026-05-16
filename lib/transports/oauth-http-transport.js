'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const MAX_QUEUE = 100;

/**
 * OAuthHttpTransport — HTTP transport for sites authenticated with
 * OAuth 2.1 bearer tokens.
 *
 * Sibling to HttpTransport (which handles Basic / App-Password). Selected by
 * ConnectionPool when `siteConfig.auth.method === 'oauth'`.
 *
 * Surface compatible with HttpTransport: connect / send / isReady /
 * performHandshake / shutdown / onMessage / endpoint, so the rest of the
 * bridge (router, connection-pool reuse logic, healthcheck) cannot tell
 * the two apart.
 *
 * Auth:
 *   - Before each POST, resolve a usable access token via TokenManager.
 *     TokenManager handles the 300-second pre-expiry refresh per H.2.1.
 *   - Build `Authorization: Bearer ${accessToken}`.
 *   - On 401 from the resource, call TokenManager with `forceRefresh: true`
 *     and retry the request once. If the retry also returns 401, emit an
 *     auth_failed event (caller updates auth_status to "expired") and
 *     surface a structured error to the request — no third attempt.
 *
 * Queue / batch / cookie / session-token semantics mirror HttpTransport.
 * The duplication is intentional for this hotfix: extracting a shared base
 * across both transports would touch HttpTransport mid-hotfix and risk
 * regressing the App-Password runtime path. A future refactor can pull a
 * BaseHttpTransport once both implementations have stabilised.
 *
 * Out of scope for this transport (per Appendix H.2.3):
 *   - Capability pinning enforcement. The pin lives on `siteConfig` and is
 *     written by the OAuth flow (oauth-client.js) during add-site / reauth.
 *     Pinned-then-404 fail-loud belongs to the discovery layer, not to
 *     runtime MCP traffic. The transport never probes .well-known/*.
 *   - apppassword_fallback at runtime. When `auth.method === 'oauth'`,
 *     OAuth always wins — see Appendix F.5 "Precedence rule". The fallback
 *     block exists for the operator-driven `upgrade-auth` workflow only;
 *     it is NOT a runtime "if OAuth fails, try Basic" branch.
 *
 * @param {object} opts
 * @param {string} opts.endpoint              MCP resource URL (https). For
 *                                            multisite OAuth (Issue #48) the
 *                                            caller derives the subsite-host
 *                                            endpoint via resolveSiteKey and
 *                                            passes it here; the transport
 *                                            posts to whatever it's given.
 * @param {string} [opts.subsiteUrl]          Optional. When the resolved
 *                                            site key targets a multisite
 *                                            subsite, the subsite home URL
 *                                            is forwarded on every request
 *                                            via X-Abilities-MCP-Subsite-URL
 *                                            so server-side adapters that
 *                                            honour it (Phase B / future)
 *                                            can route per-request without
 *                                            re-parsing the endpoint URL.
 *                                            Subdomain-style multisite does
 *                                            not need this header — the host
 *                                            in the endpoint URL is
 *                                            sufficient — but the header is
 *                                            unconditional so path-style
 *                                            multisite works once the
 *                                            adapter consumes it.
 * @param {object} opts.tokenManager          TokenManager instance
 * @param {object} opts.siteAuth              SiteAuthState (see TokenManager)
 * @param {function} opts.onAuthStatusChange  Optional. Called with
 *                                            (newStatus, { reason, siteId })
 *                                            when transport detects a terminal
 *                                            auth failure. Caller persists.
 * @param {function} opts.onTokensRenewed     Optional. Issue #90 (opt-in
 *                                            sliding renewal). Called with
 *                                            (updatedAuth) after a successful
 *                                            refresh ONLY when
 *                                            siteAuth.slidingRenewal === true.
 *                                            Caller persists the slid
 *                                            refresh_token_expires_at + rotated
 *                                            refs + access expiry. Never
 *                                            invoked for default sites.
 * @param {function} opts.logger              Logger function
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
class OAuthHttpTransport {

  constructor(opts) {
    if (!opts || !opts.endpoint) {
      throw new Error('OAuthHttpTransport requires an endpoint');
    }
    if (!opts.tokenManager) {
      throw new Error('OAuthHttpTransport requires a tokenManager');
    }
    if (!opts.siteAuth) {
      throw new Error('OAuthHttpTransport requires siteAuth');
    }

    this.endpoint = opts.endpoint;
    this.subsiteUrl = opts.subsiteUrl || null;
    this._tokenManager = opts.tokenManager;
    this._siteAuth = opts.siteAuth;
    this._onAuthStatusChange = opts.onAuthStatusChange || null;
    // Issue #90: opt-in sliding renewal. Invoked ONLY on a successful refresh
    // of a site whose siteAuth.slidingRenewal === true, so flag-off sites
    // never reach a new write path. Caller persists the slid expiry + refs.
    this._onTokensRenewed = opts.onTokensRenewed || null;
    this.log = opts.logger || function noop() {};

    const parsedUrl = new URL(this.endpoint);
    this.parsedUrl = parsedUrl;
    this.isHttps = parsedUrl.protocol === 'https:';
    this.httpModule = this.isHttps ? https : http;

    // State
    this.sessionId = null;
    this.sessionToken = null;
    this.clientProtocolVersion = null;
    this.ready = false;
    this.onMessage = null;

    // Message queue — serialized processing
    this.messageQueue = [];
    this.processing = false;

    // Batch coalescing
    this._coalesceTimer = null;
    this._coalesceWindowMs = 10;

    // Healthcheck
    this.healthcheckTimer = null;

    // 5xx retry config (separate from the 401-once-refresh path)
    this.maxRetries = 3;
    this.baseRetryDelay = 1000;

    // Handshake cache for session recovery
    this.cachedInitRequest = null;
    this.cachedInitNotification = null;

    // Cookie jar — per-host
    this._cookies = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public surface (mirrors HttpTransport)
  // ---------------------------------------------------------------------------

  async connect() {
    this.ready = true;
    this.log(`OAuth HTTP transport ready: ${this.parsedUrl.hostname}`);
    this._startHealthcheck();
  }

  send(line) {
    if (this.messageQueue.length >= MAX_QUEUE) {
      this.log('OAuth HTTP queue full — rejecting');
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.onMessage) {
          this.onMessage({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32603, message: 'OAuth HTTP transport queue full' }
          }, null);
        }
      } catch (e) { /* ignore */ }
      return;
    }
    this.messageQueue.push(line);
    this._drainQueue();
  }

  isReady() {
    return this.ready;
  }

  async performHandshake(initRequest, initNotification) {
    this.cachedInitRequest = initRequest;
    this.cachedInitNotification = initNotification;

    if (initRequest.params && initRequest.params.protocolVersion) {
      this.clientProtocolVersion = initRequest.params.protocolVersion;
    }

    const initLine = JSON.stringify(initRequest);
    const initResult = await this._postWithRetry(initLine);
    if (initResult && initResult.body && initResult.body.trim()) {
      this.log(`OAuth HTTP handshake init response: ${initResult.statusCode}`);
    }
    if (initResult && initResult.sessionId) {
      this.sessionId = initResult.sessionId;
    }

    if (initNotification) {
      const notifLine = JSON.stringify(initNotification);
      await this._postWithRetry(notifLine);
    }
  }

  async shutdown() {
    this._stopHealthcheck();
    this.ready = false;
    this.log(`OAuth HTTP transport shutdown: ${this.parsedUrl.hostname}`);
  }

  // ---------------------------------------------------------------------------
  // Internal — queue / batch (mirrors HttpTransport)
  // ---------------------------------------------------------------------------

  _drainQueue() {
    if (this.processing || this._coalesceTimer) return;

    this._coalesceTimer = setTimeout(async () => {
      this._coalesceTimer = null;
      if (this.processing || this.messageQueue.length === 0) return;

      this.processing = true;
      const batch = this.messageQueue.splice(0);

      if (batch.length === 1) {
        await this._processMessage(batch[0]);
      } else {
        await this._processBatch(batch);
      }

      this.processing = false;

      if (this.messageQueue.length > 0) {
        this._drainQueue();
      }
    }, this._coalesceWindowMs);
  }

  async _processBatch(lines) {
    const parsed = [];
    const fallback = [];
    for (const line of lines) {
      try {
        parsed.push({ line, msg: JSON.parse(line) });
      } catch {
        fallback.push(line);
      }
    }

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

    const requests = parsed.filter(({ msg }) => 'id' in msg);
    const notifications = parsed.filter(({ msg }) => !('id' in msg));

    for (const { line } of notifications) {
      try { await this._postWithRetry(line); } catch { /* ignore */ }
    }

    if (requests.length === 0) {
      for (const line of fallback) await this._processMessage(line);
      return;
    }

    const batchBody = JSON.stringify(requests.map(({ msg }) => msg));

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
          for (const { msg } of requests) {
            pending.get(String(msg.id))?.({
              jsonrpc: '2.0', id: msg.id,
              error: { code: -32700, message: 'Batch response parse error' },
            });
          }
          return;
        }

        if (Array.isArray(batchResponse)) {
          for (let resp of batchResponse) {
            const resolver = pending.get(String(resp.id));
            if (resolver) {
              resolver(resp);
              pending.delete(String(resp.id));
            }
          }
        } else {
          const resp = batchResponse;
          const resolver = pending.get(String(resp.id));
          if (resolver) {
            resolver(resp);
            pending.delete(String(resp.id));
          }
        }
      }
    } catch (err) {
      this.log(`OAuth HTTP batch error: ${err.message}`);
      for (const { msg } of requests) {
        pending.get(String(msg.id))?.({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32000, message: `OAuth HTTP batch error: ${err.message}` },
        });
      }
    }

    for (const [id, resolve] of pending.entries()) {
      resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: 'No response in batch' } });
    }

    const responses = await Promise.all(resultPromises);
    for (const resp of responses) {
      if (this.onMessage) this.onMessage(resp, JSON.stringify(resp));
    }

    for (const line of fallback) {
      await this._processMessage(line);
    }
  }

  async _processMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (this.onMessage) {
        this.onMessage({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error' },
        }, null);
      }
      return;
    }

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
          if (this.onMessage) this.onMessage(null, rawLine);
          return;
        }

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

        if (this.onMessage) this.onMessage(parsed, JSON.stringify(parsed));
      }
    } catch (err) {
      this.log(`OAuth HTTP error for ${msg.method || 'unknown'}: ${err.message}`);
      if (!isNotification && this.onMessage) {
        this.onMessage({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32000, message: `OAuth HTTP bridge error: ${err.message}` },
        }, null);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — POST with retry
  //
  // Two distinct retry concerns layered on top of each other:
  //   1. Bearer freshness: TokenManager refreshes within 300s of expiry on
  //      the way in. On a 401 from the resource we do exactly one
  //      forceRefresh + retry — second 401 is terminal and fails the request.
  //   2. Transport-level retries on 5xx and network errors, mirroring the
  //      App-Password transport so basic robustness matches.
  // ---------------------------------------------------------------------------

  async _postWithRetry(body, attempt = 0, retryAfterRefresh = false) {
    let bearer;
    try {
      const tok = await this._tokenManager.getAccessToken(this._siteAuth, {
        forceRefresh: retryAfterRefresh,
      });
      bearer = tok.accessToken;
      if (tok.refreshed && tok.updatedAuth) {
        // Adopt the rotated refs / new expiry locally so subsequent calls
        // skip the refresh window check until next pre-expiry. The on-disk
        // config is updated by the auth_status_change consumer if wired.
        this._siteAuth = {
          ...this._siteAuth,
          accessTokenRef: tok.updatedAuth.accessTokenRef,
          refreshTokenRef: tok.updatedAuth.refreshTokenRef,
          accessTokenExpiresAt: tok.updatedAuth.accessTokenExpiresAt,
          authStatus: tok.updatedAuth.authStatus,
        };
        // Issue #90: opt-in sliding renewal ONLY. For default (flag
        // absent/false) sites this branch is skipped entirely — no extra
        // in-memory expiry adoption, no persist callback, no new write path.
        // For opt-in sites, adopt the slid refresh-token expiry in-memory and
        // ask the caller to persist it (+ rotated refs + access expiry).
        if (this._siteAuth.slidingRenewal === true) {
          this._siteAuth.refreshTokenExpiresAt = tok.updatedAuth.refreshTokenExpiresAt;
          if (this._onTokensRenewed) {
            try {
              this._onTokensRenewed(tok.updatedAuth);
            } catch { /* observer must not break the request path */ }
          }
        }
      }
    } catch (err) {
      // Refresh failure (e.g. RefreshError 4xx → expired). Emit auth status
      // change so caller can update wp-sites.json, then surface to caller.
      if (err && err.updatedAuth && this._onAuthStatusChange) {
        try {
          this._onAuthStatusChange(err.updatedAuth.authStatus, {
            reason: 'refresh_failed',
            siteId: this._siteAuth.siteId,
            cause: err,
          });
        } catch { /* observer must not break the request path */ }
      }
      const reauthHint = err && err.reauthHint
        ? ` (run: ${err.reauthHint.command})`
        : '';
      const wrapped = new Error(`OAuth refresh failed${reauthHint}: ${err && err.message || err}`);
      wrapped.cause = err;
      wrapped.code = (err && err.code) || 'oauth_refresh_failed';
      wrapped.reauth = true;
      throw wrapped;
    }

    let result;
    try {
      result = await this._post(body, bearer);
    } catch (err) {
      // Network error — retry with backoff (mirror HttpTransport).
      if (attempt < this.maxRetries) {
        const delay = this.baseRetryDelay * Math.pow(2, attempt);
        this.log(`OAuth HTTP network error — retrying in ${delay}ms: ${err.message}`);
        await this._sleep(delay);
        return this._postWithRetry(body, attempt + 1, false);
      }
      throw err;
    }

    // 401 from resource — bearer is stale. Force-refresh once and retry.
    // Per Appendix H.2.1 + Issue #17 acceptance: do this exactly once. A
    // second 401 marks the site expired and surfaces a reauth hint.
    if (result.statusCode === 401 && !retryAfterRefresh) {
      this.log('OAuth HTTP 401 from resource — forcing token refresh and retrying once');
      return this._postWithRetry(body, attempt, true);
    }
    if (result.statusCode === 401 && retryAfterRefresh) {
      // Two 401s in a row with a freshly-minted token — token is dead or the
      // server has revoked. Treat as terminal, mark expired, fail the request.
      const expiredErr = new Error(
        `OAuth bearer rejected after refresh (HTTP 401). ` +
        `Run: abilities-mcp reauth ${this._siteAuth.siteId}`
      );
      expiredErr.code = 'oauth_bearer_rejected';
      expiredErr.reauth = true;
      expiredErr.statusCode = 401;
      if (this._onAuthStatusChange) {
        try {
          this._onAuthStatusChange('expired', {
            reason: 'bearer_rejected_after_refresh',
            siteId: this._siteAuth.siteId,
          });
        } catch { /* observer must not break the request path */ }
      }
      throw expiredErr;
    }

    // Session recovery — same triggers as HttpTransport, except 401/403 with
    // an active session is now AT MOST a stale-session signal. Bearer staleness
    // is already handled above, so a 401 reaching this branch means the token
    // is fresh but the MCP session expired. We still allow one re-handshake.
    const isExplicitExpiry = result.statusCode === 404 || result.statusCode === 410;
    const isStaleSession = result.statusCode === 403 && this.sessionId !== null;
    if ((isExplicitExpiry || isStaleSession) && attempt === 0) {
      this.log(`OAuth HTTP session expired (HTTP ${result.statusCode}) — attempting recovery`);
      this.sessionId = null;
      this.sessionToken = null;
      if (this.cachedInitRequest) {
        await this.performHandshake(this.cachedInitRequest, this.cachedInitNotification);
        return this._postWithRetry(body, attempt + 1, false);
      }
    }

    // 5xx retry with backoff
    if (result.statusCode >= 500 && attempt < this.maxRetries) {
      const delay = this.baseRetryDelay * Math.pow(2, attempt);
      this.log(`OAuth HTTP ${result.statusCode} — retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
      await this._sleep(delay);
      return this._postWithRetry(body, attempt + 1, false);
    }

    return result;
  }

  _post(body, bearer) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearer}`,
        'Accept': 'application/json',
      };

      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      if (this.sessionToken) headers['Mcp-Session-Token'] = this.sessionToken;
      // Forward subsite context for multisite OAuth (Issue #48). Subdomain-
      // style multisite already routes by host in the endpoint URL; the
      // header is forward-looking infrastructure for path-style multisite
      // (Phase B), so the server can switch_to_blog() without re-parsing
      // the request URL.
      if (this.subsiteUrl) headers['X-Abilities-MCP-Subsite-URL'] = this.subsiteUrl;

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
          const newSessionId = res.headers['mcp-session-id'];
          if (newSessionId) this.sessionId = newSessionId;
          const newSessionToken = res.headers['mcp-session-token'];
          if (newSessionToken) this.sessionToken = newSessionToken;

          const setCookieHeader = res.headers['set-cookie'];
          if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            if (!this._cookies.has(this.parsedUrl.hostname)) {
              this._cookies.set(this.parsedUrl.hostname, new Map());
            }
            const jar = this._cookies.get(this.parsedUrl.hostname);
            for (const raw of cookies) {
              const nameValue = raw.split(';')[0].trim();
              const eqIdx = nameValue.indexOf('=');
              if (eqIdx > 0) {
                jar.set(nameValue.slice(0, eqIdx), nameValue.slice(eqIdx + 1));
              }
            }
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
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
  // Internal — healthcheck (matches HttpTransport cadence)
  // ---------------------------------------------------------------------------

  _startHealthcheck() {
    this._stopHealthcheck();
    this.healthcheckTimer = setInterval(() => {
      this._sendPing();
    }, 45000);
    if (this.healthcheckTimer.unref) this.healthcheckTimer.unref();
  }

  _stopHealthcheck() {
    if (this.healthcheckTimer) {
      clearInterval(this.healthcheckTimer);
      this.healthcheckTimer = null;
    }
  }

  async _sendPing() {
    const pingMsg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'ping',
      id: `__healthcheck_${Date.now()}`,
    });
    try {
      const result = await this._postWithRetry(pingMsg);
      this.log(`OAuth HTTP healthcheck: ${result.statusCode}`);
    } catch (err) {
      this.log(`OAuth HTTP healthcheck failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — utils
  // ---------------------------------------------------------------------------

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { OAuthHttpTransport };
