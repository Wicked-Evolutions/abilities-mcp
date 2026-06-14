'use strict';

const { SshTransport } = require('./transports/ssh-transport');
const { resolveSiteKey, resolveSitePassword } = require('./config');
const { AUTH_STATUS } = require('./auth/events');

// Incrementing counter for synthetic handshake IDs.
// Avoids integer overflow from Date.now() (13-digit ms timestamps exceed
// 32-bit int max, causing TypeError in PHP strict_types=1 environments).
// Starting at 1000 to avoid collision with real request IDs (typically 1+).
let _synthIdCounter = 1000;

/**
 * Build a TokenManager-shaped siteAuth object from a v2 OAuth site block.
 * The OAuthHttpTransport and TokenManager use this shape.
 */
function _siteAuthFromConfig(siteId, siteConfig, asMetadata) {
  return {
    siteId,
    tokenEndpoint: asMetadata && asMetadata.token_endpoint,
    clientId: siteConfig.auth.client_id,
    accessTokenRef: siteConfig.auth.access_token_ref,
    refreshTokenRef: siteConfig.auth.refresh_token_ref,
    accessTokenExpiresAt: siteConfig.auth.access_token_expires_at,
    refreshTokenExpiresAt: siteConfig.auth.refresh_token_expires_at,
    authStatus: siteConfig.auth_status || 'active',
    // Issue #90: opt-in sliding renewal. Strictly === true so any
    // missing/false/truthy-but-not-true value is the default bounded path.
    //
    // SECURITY TRADE-OFF (operator chose this per-site by setting
    // auth.sliding_renewal:true in wp-sites.json): an actively-used site's
    // refresh window then extends indefinitely, so a leaked refresh token has
    // a longer blast radius than the default ≤90-days-from-initial-auth cap.
    // Never enabled implicitly / by migration / by add-site|reauth. See
    // README "Sliding-renewal OAuth (opt-in, off by default)".
    slidingRenewal: siteConfig.auth.sliding_renewal === true,
  };
}

/**
 * Connection Pool — manages one transport per site, lazily instantiated.
 *
 * Each site gets its own independent SSH (or HTTP) connection with its own
 * reconnection state. The pool caches the MCP handshake messages so it can
 * replay them when connecting to a new site mid-session.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
class ConnectionPool {

  /**
   * @param {object} config
   * @param {function} logger
   * @param {object} [deps]                   Optional injection seam for tests
   * @param {object} [deps.secretStore]       Defaults to KeychainSecretStore
   * @param {object} [deps.tokenManager]      Defaults to a TokenManager built from secretStore
   * @param {function} [deps.discover]        Defaults to lib/auth/discovery-client.discover
   * @param {function} [deps.persistAuthStatus] (siteId, newStatus) => void
   *                                          Persists to wp-sites.json. Defaults to
   *                                          atomic write via config-migration._atomicWrite
   *                                          when config._configPath is set.
   * @param {function} [deps.persistSlidingRenewal] (siteId, updatedAuth) => void
   *                                          Issue #90. Persists the slid
   *                                          refresh expiry + rotated refs for
   *                                          opt-in sites only. Defaults to an
   *                                          atomic write when _configPath set.
   * @param {boolean} [deps.allowInsecure]    For local-dev OAuth over HTTP
   */
  constructor(config, logger, deps = {}) {
    this.config = config;
    this.log = logger;
    this.transports = new Map();      // compositeKey -> Transport
    this.connecting = new Map();      // compositeKey -> Promise<Transport>

    // OAuth-runtime deps. Built lazily so SSH-only / App-Password-only setups
    // never load keytar or the auth modules at all.
    this._deps = deps;
    this._secretStore = deps.secretStore || null;
    this._tokenManager = deps.tokenManager || null;
    this._discover = deps.discover || null;
    this._allowInsecure = !!deps.allowInsecure;
    this._persistAuthStatus = deps.persistAuthStatus || null;
    this._persistSlidingRenewal = deps.persistSlidingRenewal || null;

    // Cache of OAuth AS metadata per site URL — avoids re-probing .well-known
    // on every transport rebuild. Refreshed when the transport is recreated.
    this._asMetadataCache = new Map();   // siteUrl -> { asMetadata, prMetadata }

    // Handshake cache — set after the default site completes init
    this.cachedInitRequest = null;
    this.cachedInitNotification = null;
    this.clientProtocolVersion = null;
  }

  /**
   * Cache the client's handshake messages for replay to other sites.
   */
  setHandshakeCache(initRequest, initNotification, protocolVersion) {
    this.cachedInitRequest = initRequest;
    this.cachedInitNotification = initNotification;
    this.clientProtocolVersion = protocolVersion;
  }

  /**
   * Get or lazily create a transport for a composite site key.
   * Handles "helena", "wicked", "wicked.community" etc.
   *
   * For HTTP transport, multisite subsites (e.g. "wicked.community") share the
   * same endpoint as their parent site ("wicked"). Creating a second transport
   * to the same endpoint causes session contention. Instead, we reuse the
   * existing transport — the WordPress MCP adapter handles subsite routing
   * internally.
   */
  async getTransport(compositeKey) {
    // Return existing
    if (this.transports.has(compositeKey)) {
      return this.transports.get(compositeKey);
    }

    // For HTTP multisite subsites, reuse the parent site's transport if it
    // connects to the same endpoint. This avoids two transports competing
    // for sessions on the same WordPress install.
    const existing = this._findExistingHttpTransport(compositeKey);
    if (existing) {
      this.log(`Reusing transport for ${compositeKey} (same endpoint as ${existing.key})`);
      this.transports.set(compositeKey, existing.transport);
      return existing.transport;
    }

    // Prevent concurrent creation
    if (this.connecting.has(compositeKey)) {
      return this.connecting.get(compositeKey);
    }

    const promise = this._create(compositeKey);
    this.connecting.set(compositeKey, promise);
    try {
      const transport = await promise;
      this.connecting.delete(compositeKey);
      return transport;
    } catch (err) {
      this.connecting.delete(compositeKey);
      throw err;
    }
  }

  /**
   * Get the default site's transport (must already exist).
   */
  getDefaultTransport() {
    return this.transports.get(this.config.defaultSite) || null;
  }

  /**
   * Create and connect transport for the default site (no handshake replay).
   * Called once at startup — the client handles the handshake directly.
   *
   * Issue #76: per-site auth-init isolation. The configured `defaultSite` is
   * tried first; if its `_createTransport` / `transport.connect()` throws
   * (typically a `RefreshError` when the refresh token is expired — confirmed
   * via static trace from `lib/auth/token-manager.js:147-152`), the failure
   * is captured against the site's in-memory `auth_status` and the next
   * configured site is tried in `Object.keys(config.sites)` order. The first
   * site that connects becomes the runtime default (`config.defaultSite` is
   * reassigned in-memory only — wp-sites.json on disk is untouched).
   *
   * Returns `null` when ALL configured sites fail. The bootstrap caller pairs
   * a `null` return with `router.enterDegradedMode(...)` so the bridge still
   * answers `initialize` with a valid `InitializeResult` — the failure mode
   * the gate explicitly forbids (init-time bridge death) cannot recur.
   *
   * @param {function} onMessage  Per-site message router callback.
   * @returns {Promise<Transport|null>}
   */
  async connectDefault(onMessage) {
    const configuredDefault = this.config.defaultSite;
    const otherKeys = Object.keys(this.config.sites).filter((k) => k !== configuredDefault);
    const tryOrder = [configuredDefault, ...otherKeys];

    for (const key of tryOrder) {
      try {
        const transport = await this._createTransport(key, null);
        transport.onMessage = onMessage;
        await transport.connect();
        this.transports.set(key, transport);

        if (key !== configuredDefault) {
          this.log(
            `Configured default "${configuredDefault}" failed to connect; ` +
            `runtime default fell back to "${key}". The configured default ` +
            `is marked degraded in-memory; reauth it to restore.`
          );
          this.config.defaultSite = key;
        }
        return transport;
      } catch (err) {
        this.log(`Site "${key}" failed to connect at boot: ${err.message}`);
        this._markSiteDegraded(key, err);
      }
    }

    return null;
  }

  /**
   * Issue #87 (S1/S2): request-time per-site fallback.
   *
   * OAuth `transport.connect()` does NOT pre-validate refresh tokens
   * (lib/transports/oauth-http-transport.js — sets ready, returns). So a
   * default site with an expired refresh token connects cleanly at boot and
   * `connectDefault` never falls back; the failure only surfaces when the
   * cached `initialize` is forwarded and the refresh throws. This mirrors
   * `connectDefault`'s boot-time fallback at request time: tear down the
   * known-failed sites' stale transports, then connect the first site NOT in
   * the exclude list and promote it to runtime default. Returns the new
   * transport, or `null` when no non-excluded site can serve (the genuine
   * "all sites failed" condition — the caller then enters degraded mode per
   * the #76 gate).
   *
   * The caller (router) accumulates every site that has failed the
   * re-forwarded cached initialize and passes the full set here, because
   * `transport.connect()` does not validate tokens — a freshly-connected
   * fallback can itself fail the initialize. Excluding the accumulated set
   * makes the candidate pool strictly shrink so the chain converges (reviewer
   * blocker, PR #88).
   *
   * @param {string|string[]} excludeSiteIds  Site id(s) already known to have
   *   failed the cached initialize/connect — never re-tried here.
   * @param {function} onMessage   Per-site message router callback.
   * @returns {Promise<Transport|null>}
   */
  async connectFallback(excludeSiteIds, onMessage) {
    const excluded = new Set(
      Array.isArray(excludeSiteIds) ? excludeSiteIds : [excludeSiteIds]
    );

    for (const siteId of excluded) {
      const stale = this.transports.get(siteId);
      if (stale) {
        try { await stale.shutdown(); } catch { /* best effort — stale anyway */ }
        this.transports.delete(siteId);
      }
    }

    const tryOrder = Object.keys(this.config.sites).filter((k) => !excluded.has(k));
    for (const key of tryOrder) {
      try {
        const transport = await this._createTransport(key, null);
        transport.onMessage = onMessage;
        await transport.connect();
        this.transports.set(key, transport);
        this.config.defaultSite = key;
        this.log(
          `Default failed at request time (excluded: ${[...excluded].join(', ')}); ` +
          `runtime default fell back to "${key}". Excluded sites are marked ` +
          `degraded in-memory; reauth to restore.`
        );
        return transport;
      } catch (err) {
        this.log(`Fallback site "${key}" failed to connect: ${err.message}`);
        this._markSiteDegraded(key, err);
      }
    }

    return null;
  }

  /**
   * Mark a site degraded in the in-memory config so other lookups (tools/list,
   * resources/read wp-abilities://sites, per-call routing) can surface it
   * without re-attempting the failed connection. The on-disk wp-sites.json is
   * NOT rewritten here — degraded state is recoverable (operator runs reauth)
   * and the next bridge boot will re-attempt the connection from the existing
   * persisted state.
   *
   * @private
   */
  _markSiteDegraded(siteId, err) {
    const site = this.config.sites && this.config.sites[siteId];
    if (!site) return;
    site.auth_status = AUTH_STATUS.EXPIRED;
    site._degraded_reason = (err && err.message) || 'connect failed';
  }

  /**
   * Get list of currently connected composite keys.
   */
  getConnectedKeys() {
    return Array.from(this.transports.keys());
  }

  /**
   * Check if a composite key has an active, ready transport.
   */
  isConnected(compositeKey) {
    const transport = this.transports.get(compositeKey);
    return !!(transport && transport.isReady());
  }

  /**
   * Probe connectivity to a site. If already connected, checks transport state.
   * If not connected, does a lightweight SSH or HTTP reachability test.
   * Returns { status, latencyMs, error? }
   */
  async healthCheck(compositeKey) {
    const start = Date.now();

    // Already connected — check transport state
    const transport = this.transports.get(compositeKey);
    if (transport) {
      if (transport.isReady()) {
        return { status: 'connected', latencyMs: Date.now() - start };
      }
      if (transport.reconnecting) {
        return { status: 'reconnecting', latencyMs: Date.now() - start };
      }
      return { status: 'stale', latencyMs: Date.now() - start };
    }

    // Not connected — lightweight probe
    const { resolveSiteKey } = require('./config');
    try {
      const { siteConfig } = resolveSiteKey(this.config, compositeKey);

      // v2 OAuth site — probe the resource URL with HEAD. We do NOT mint a
      // token here; this is just a reachability check, the real auth happens
      // on first MCP request via OAuthHttpTransport.
      if (siteConfig.auth && siteConfig.auth.method === 'oauth') {
        const target = siteConfig.mcp_resource;
        if (!target) {
          return { status: 'unreachable', latencyMs: Date.now() - start, error: 'no mcp_resource configured' };
        }
        const mod = target.startsWith('https://') ? require('https') : require('http');
        const url = new URL(target);
        await new Promise((resolve, reject) => {
          const req = mod.request({
            hostname: url.hostname, port: url.port,
            path: url.pathname, method: 'HEAD', timeout: 10000,
          }, (res) => resolve(res.statusCode));
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });
        return { status: 'reachable', latencyMs: Date.now() - start };
      }

      if (siteConfig.transport === 'ssh') {
        const { execFileSync } = require('child_process');
        execFileSync('ssh', [
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=5',
          siteConfig.ssh.host,
          'echo ok',
        ], { timeout: 10000, encoding: 'utf8' });
        return { status: 'reachable', latencyMs: Date.now() - start };
      }

      if (siteConfig.transport === 'http') {
        const mod = siteConfig.http.endpoint.startsWith('https://') ? require('https') : require('http');
        const url = new URL(siteConfig.http.endpoint);
        await new Promise((resolve, reject) => {
          const req = mod.request({
            hostname: url.hostname, port: url.port,
            path: url.pathname, method: 'HEAD', timeout: 10000,
          }, (res) => resolve(res.statusCode));
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });
        return { status: 'reachable', latencyMs: Date.now() - start };
      }

      return { status: 'unknown_transport', latencyMs: Date.now() - start };
    } catch (err) {
      return { status: 'unreachable', latencyMs: Date.now() - start, error: err.message };
    }
  }

  /**
   * Shut down all transports.
   */
  async shutdownAll() {
    const promises = [];
    for (const [key, transport] of this.transports) {
      this.log(`Shutting down transport: ${key}`);
      promises.push(transport.shutdown());
    }
    await Promise.allSettled(promises);
    this.transports.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async _create(compositeKey) {
    const { subsiteUrl } = resolveSiteKey(this.config, compositeKey);

    this.log(`Lazy-connecting to site: ${compositeKey}`);

    const transport = await this._createTransport(compositeKey, subsiteUrl);

    // Set up message callback — route responses back to main
    // The main entry will set this after getting the transport
    transport.onMessage = null; // Caller must set this

    await transport.connect();

    // Replay handshake if we have cached init messages
    if (this.cachedInitRequest) {
      // Use a numeric ID — WordPress MCP adapter's InitializeHandler declares
      // strict_types=1 and expects int $request_id. String IDs cause TypeError → 500.
      const synthInit = { ...this.cachedInitRequest, id: _synthIdCounter++ };
      await transport.performHandshake(synthInit, this.cachedInitNotification);
      this.log(`Handshake replayed for ${compositeKey}`);
    }

    this.transports.set(compositeKey, transport);
    return transport;
  }

  async _createTransport(compositeKey, subsiteUrl) {
    const { siteConfig, subsiteUrl: resolvedSubsiteUrl, resolvedEndpoint } = resolveSiteKey(this.config, compositeKey);
    const finalSubsiteUrl = subsiteUrl || resolvedSubsiteUrl;

    // v2 OAuth dispatch — single branch per Issue #17 acceptance criteria.
    // Sites with auth.method === 'oauth' use the OAuth-aware HTTP transport;
    // every other site (App Password, SSH carrier-only) keeps the existing
    // legacy code paths untouched.
    //
    // Pass the resolved subsite endpoint and URL through. For multisite OAuth
    // (Issue #48) the OAuth branch must POST to the subsite host, not the
    // network root — mirroring the HTTP branch's `resolvedEndpoint || ...`
    // pattern below.
    if (siteConfig.auth && siteConfig.auth.method === 'oauth') {
      return this._createOAuthHttpTransport(compositeKey, siteConfig, {
        resolvedEndpoint,
        subsiteUrl: finalSubsiteUrl,
      });
    }

    if (siteConfig.transport === 'ssh') {
      return new SshTransport({
        host: siteConfig.ssh.host,
        path: siteConfig.ssh.path,
        user: siteConfig.ssh.user,
        mcpServer: siteConfig.mcpServer || 'abilities-mcp-adapter-default-server',
        subsiteUrl: finalSubsiteUrl,
        logger: this.log,
      });
    }

    if (siteConfig.transport === 'http') {
      // HTTP transport — loaded lazily to avoid requiring it when only SSH is used.
      // v2 apppassword sites resolve the secret from keychain via auth.password_ref;
      // v1 sites fall through to the legacy synchronous resolver. KeychainSecretStore
      // is only constructed when an apppassword path actually runs, preserving the
      // "no keytar for SSH-only / v1-only setups" property.
      const { HttpTransport } = require('./transports/http-transport');
      const isV2AppPassword = siteConfig.auth
        && siteConfig.auth.method === 'apppassword'
        && siteConfig.auth.password_ref;
      if (isV2AppPassword && !this._secretStore) {
        const { KeychainSecretStore } = require('./auth/keychain-secret-store');
        this._secretStore = new KeychainSecretStore();
      }
      const password = await resolveSitePassword(siteConfig, this._secretStore);
      const username = (siteConfig.auth && siteConfig.auth.username) || siteConfig.http.username;
      return new HttpTransport({
        endpoint: resolvedEndpoint || siteConfig.http.endpoint,
        username,
        password,
        logger: this.log,
      });
    }

    throw new Error(`Unknown transport: ${siteConfig.transport}`);
  }

  /**
   * Build an OAuthHttpTransport for a v2 OAuth site. Lazily resolves AS
   * metadata via the discovery client (passing capability-pin state per
   * Appendix H.2.3 — pinned-then-404 throws CapabilityPinningError, which
   * we let propagate so the bridge fails loud rather than silently
   * downgrading to App Password).
   */
  async _createOAuthHttpTransport(compositeKey, siteConfig, { resolvedEndpoint, subsiteUrl } = {}) {
    const { OAuthHttpTransport } = require('./transports/oauth-http-transport');
    const { TokenManager } = require('./auth/token-manager');
    const { discover } = require('./auth/discovery-client');

    if (!siteConfig.mcp_resource) {
      throw new Error(
        `Site "${compositeKey}" (oauth): no mcp_resource configured — ` +
        `re-run \`abilities-mcp reauth ${compositeKey}\` to repopulate it`
      );
    }
    if (!siteConfig.url) {
      throw new Error(`Site "${compositeKey}" (oauth): no url configured`);
    }

    if (!this._secretStore) {
      const { KeychainSecretStore } = require('./auth/keychain-secret-store');
      this._secretStore = new KeychainSecretStore();
    }
    if (!this._tokenManager) {
      this._tokenManager = new TokenManager({
        secretStore: this._secretStore,
        allowInsecure: this._allowInsecure,
      });
    }
    const discoverFn = this._discover || discover;

    let asMetadata = (this._asMetadataCache.get(siteConfig.url) || {}).asMetadata;
    let prMetadata = (this._asMetadataCache.get(siteConfig.url) || {}).prMetadata;
    // Issue #103 (P3): re-run discovery when AS metadata is missing OR when a
    // prior attempt cached a null protected-resource. A transient
    // .well-known/oauth-protected-resource failure must not poison Component B's
    // live-resource preference for the whole process lifetime.
    if (!asMetadata || !prMetadata) {
      const result = await discoverFn(siteConfig.url, {
        pinned: !!siteConfig.oauth_capability_pinned,
        pinnedFirstSeenAt: siteConfig.oauth_capability_pinned
          && siteConfig.oauth_capability_pinned.first_seen_at,
        allowInsecure: this._allowInsecure,
      });
      asMetadata = result.asMetadata;
      prMetadata = result.prMetadata;
      this._asMetadataCache.set(siteConfig.url, {
        asMetadata: result.asMetadata,
        prMetadata: result.prMetadata,
      });
    }

    if (!asMetadata || !asMetadata.token_endpoint) {
      throw new Error(
        `Site "${compositeKey}" (oauth): discovery did not yield a token_endpoint`
      );
    }

    const siteAuth = _siteAuthFromConfig(compositeKey, siteConfig, asMetadata);

    // Issue #103 (Component B): prefer the live-discovered protected-resource
    // URL over the stale persisted mcp_resource when they differ. The RFC 9728
    // .well-known/oauth-protected-resource document is authoritative; the
    // persisted value may be stale if the server's adapter route was renamed.
    // resolvedEndpoint (multisite subsite case) still wins unconditionally —
    // it is derived from the operator-configured multisite map, not discovery.
    const discoveredResource = prMetadata && prMetadata.resource;
    let endpoint = resolvedEndpoint || siteConfig.mcp_resource;
    if (!resolvedEndpoint && discoveredResource && discoveredResource !== siteConfig.mcp_resource) {
      this.log(
        `Site "${compositeKey}": persisted mcp_resource (${siteConfig.mcp_resource}) ` +
        `differs from live .well-known protected-resource (${discoveredResource}) — ` +
        `using live-discovered resource (RFC 9728 authoritative). Re-run ` +
        `\`abilities-mcp reauth ${compositeKey}\` to refresh the persisted value.`
      );
      endpoint = discoveredResource;
    }

    return new OAuthHttpTransport({
      endpoint,
      subsiteUrl: subsiteUrl || null,
      tokenManager: this._tokenManager,
      siteAuth,
      onAuthStatusChange: (newStatus, info) => {
        // In-memory update first so subsequent transport rebuilds see it.
        try {
          siteConfig.auth_status = newStatus;
        } catch { /* siteConfig may be frozen in tests — ignore */ }
        this.log(
          `OAuth auth_status change: ${compositeKey} → ${newStatus} (${info && info.reason || 'unknown'})`
        );
        // Persist to wp-sites.json best-effort. A failure to write should
        // not break the request path that triggered this change.
        if (this._persistAuthStatus) {
          Promise.resolve()
            .then(() => this._persistAuthStatus(compositeKey, newStatus, info))
            .catch((err) => this.log(`OAuth auth_status persist failed: ${err.message}`));
        } else if (this.config && this.config._configPath) {
          this._defaultPersistAuthStatus(compositeKey, newStatus)
            .catch((err) => this.log(`OAuth auth_status persist failed: ${err.message}`));
        }
      },
      // Issue #90: opt-in sliding renewal. The transport invokes this ONLY
      // after a successful refresh of a site whose siteAuth.slidingRenewal ===
      // true — flag-off (default) sites never reach this callback, so no new
      // write path is created for them (binding guardrail 1).
      onTokensRenewed: (updatedAuth) => {
        try {
          siteConfig.auth.refresh_token_expires_at = updatedAuth.refreshTokenExpiresAt;
          siteConfig.auth.access_token_expires_at = updatedAuth.accessTokenExpiresAt;
          siteConfig.auth.access_token_ref = updatedAuth.accessTokenRef;
          siteConfig.auth.refresh_token_ref = updatedAuth.refreshTokenRef;
        } catch { /* siteConfig may be frozen in tests — ignore */ }
        this.log(`OAuth sliding renewal: ${compositeKey} → refresh window slid to ${updatedAuth.refreshTokenExpiresAt}`);
        if (this._persistSlidingRenewal) {
          Promise.resolve()
            .then(() => this._persistSlidingRenewal(compositeKey, updatedAuth))
            .catch((err) => this.log(`OAuth sliding-renewal persist failed: ${err.message}`));
        } else if (this.config && this.config._configPath) {
          this._defaultPersistSlidingRenewal(compositeKey, updatedAuth)
            .catch((err) => this.log(`OAuth sliding-renewal persist failed: ${err.message}`));
        }
      },
      logger: this.log,
    });
  }

  /**
   * Default auth_status persistor — atomic rewrite of wp-sites.json. Used
   * when the pool was constructed without a custom persistAuthStatus.
   */
  async _defaultPersistAuthStatus(siteId, newStatus) {
    const { _atomicWrite } = require('./auth/config-migration');
    const fs = require('node:fs');
    const filePath = this.config._configPath;
    if (!filePath) return;
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`read ${filePath}: ${err.message}`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) {
      throw new Error(`parse ${filePath}: ${err.message}`);
    }
    if (parsed && parsed.sites && parsed.sites[siteId]) {
      parsed.sites[siteId].auth_status = newStatus;
      await _atomicWrite(filePath, parsed);
    }
  }

  /**
   * Issue #90: default sliding-renewal persistor — atomic rewrite of the slid
   * refresh-token expiry and rotated refs. Reached ONLY via the transport's
   * onTokensRenewed callback, which fires solely for opt-in sites
   * (siteAuth.slidingRenewal === true) after a successful refresh — flag-off
   * sites never get here, so the default bounded behavior writes nothing new
   * (binding guardrail 1 & 2). Best-effort: a write failure must not break the
   * request path that triggered the renewal.
   */
  async _defaultPersistSlidingRenewal(siteId, updatedAuth) {
    const { _atomicWrite } = require('./auth/config-migration');
    const fs = require('node:fs');
    const filePath = this.config._configPath;
    if (!filePath) return;
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`read ${filePath}: ${err.message}`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) {
      throw new Error(`parse ${filePath}: ${err.message}`);
    }
    if (parsed && parsed.sites && parsed.sites[siteId] && parsed.sites[siteId].auth) {
      const auth = parsed.sites[siteId].auth;
      auth.refresh_token_expires_at = updatedAuth.refreshTokenExpiresAt;
      auth.access_token_expires_at = updatedAuth.accessTokenExpiresAt;
      auth.access_token_ref = updatedAuth.accessTokenRef;
      auth.refresh_token_ref = updatedAuth.refreshTokenRef;
      await _atomicWrite(filePath, parsed);
    }
  }

  /**
   * Check if a composite key resolves to the same HTTP endpoint as an
   * already-connected transport. Returns { key, transport } or null.
   *
   * Covers both v1 App-Password HTTP sites and v2 OAuth sites — the dedup
   * target is whichever URL the eventual transport will POST to.
   */
  _findExistingHttpTransport(compositeKey) {
    const { siteConfig, resolvedEndpoint } = resolveSiteKey(this.config, compositeKey);

    // The dedupe target must be the *subsite* endpoint when one is resolved,
    // otherwise different subsite keys collapse onto whichever transport
    // happens to be cached first — which was the v1.5.4 multisite-OAuth
    // failure mode (Issue #48): every wickedevolutions.<subsite> reused the
    // network-root transport built for `wickedevolutions`. Single-site keys
    // (resolvedEndpoint=null) still fall back to siteConfig.mcp_resource /
    // http.endpoint, which is what dedupes parent + same-host subsites.
    let targetEndpoint = null;
    if (siteConfig.auth && siteConfig.auth.method === 'oauth') {
      targetEndpoint = resolvedEndpoint || siteConfig.mcp_resource;
    } else if (siteConfig.transport === 'http') {
      targetEndpoint = resolvedEndpoint || (siteConfig.http && siteConfig.http.endpoint);
    }
    if (!targetEndpoint) return null;

    for (const [key, transport] of this.transports) {
      if (transport.endpoint === targetEndpoint) {
        return { key, transport };
      }
    }
    return null;
  }
}

module.exports = { ConnectionPool };
