'use strict';

const { SshTransport } = require('./transports/ssh-transport');
const { resolveSiteKey, resolvePassword } = require('./config');

/**
 * Connection Pool — manages one transport per site, lazily instantiated.
 *
 * Each site gets its own independent SSH (or HTTP) connection with its own
 * reconnection state. The pool caches the MCP handshake messages so it can
 * replay them when connecting to a new site mid-session.
 */
class ConnectionPool {

  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.transports = new Map();      // compositeKey -> Transport
    this.connecting = new Map();      // compositeKey -> Promise<Transport>

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
   */
  async connectDefault(onMessage) {
    const key = this.config.defaultSite;
    const transport = this._createTransport(key, null);
    transport.onMessage = onMessage;
    await transport.connect();
    this.transports.set(key, transport);
    return transport;
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

    const transport = this._createTransport(compositeKey, subsiteUrl);

    // Set up message callback — route responses back to main
    // The main entry will set this after getting the transport
    transport.onMessage = null; // Caller must set this

    await transport.connect();

    // Replay handshake if we have cached init messages
    if (this.cachedInitRequest) {
      // Use a synthetic request ID to avoid collision
      const synthInit = { ...this.cachedInitRequest, id: `__pool_init_${compositeKey}_${Date.now()}` };
      await transport.performHandshake(synthInit, this.cachedInitNotification);
      this.log(`Handshake replayed for ${compositeKey}`);
    }

    this.transports.set(compositeKey, transport);
    return transport;
  }

  _createTransport(compositeKey, subsiteUrl) {
    const { siteConfig, subsiteUrl: resolvedSubsiteUrl, resolvedEndpoint } = resolveSiteKey(this.config, compositeKey);
    const finalSubsiteUrl = subsiteUrl || resolvedSubsiteUrl;

    if (siteConfig.transport === 'ssh') {
      return new SshTransport({
        host: siteConfig.ssh.host,
        path: siteConfig.ssh.path,
        user: siteConfig.ssh.user,
        mcpServer: siteConfig.mcpServer || 'mcp-adapter-default-server',
        subsiteUrl: finalSubsiteUrl,
        logger: this.log,
      });
    }

    if (siteConfig.transport === 'http') {
      // HTTP transport — loaded lazily to avoid requiring it when only SSH is used
      const { HttpTransport } = require('./transports/http-transport');
      const password = resolvePassword(siteConfig.http);
      return new HttpTransport({
        endpoint: resolvedEndpoint || siteConfig.http.endpoint,
        username: siteConfig.http.username,
        password: password,
        logger: this.log,
      });
    }

    throw new Error(`Unknown transport: ${siteConfig.transport}`);
  }

  /**
   * Check if a composite key resolves to the same HTTP endpoint as an
   * already-connected transport. Returns { key, transport } or null.
   */
  _findExistingHttpTransport(compositeKey) {
    const { siteConfig, resolvedEndpoint } = resolveSiteKey(this.config, compositeKey);
    if (siteConfig.transport !== 'http') return null;

    const targetEndpoint = resolvedEndpoint || siteConfig.http.endpoint;

    for (const [key, transport] of this.transports) {
      if (transport.endpoint === targetEndpoint) {
        return { key, transport };
      }
    }
    return null;
  }
}

module.exports = { ConnectionPool };
