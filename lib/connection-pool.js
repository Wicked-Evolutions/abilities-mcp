'use strict';

const { SshTransport } = require('./transports/ssh-transport');
const { resolveSiteKey } = require('./config');

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
   */
  async getTransport(compositeKey) {
    // Return existing
    if (this.transports.has(compositeKey)) {
      const t = this.transports.get(compositeKey);
      if (t.isReady()) return t;
      // If not ready but exists, wait for it
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
    const { siteConfig, subsiteUrl } = resolveSiteKey(this.config, compositeKey);

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
    const { siteConfig, subsiteUrl: resolvedSubsiteUrl } = resolveSiteKey(this.config, compositeKey);
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
      return new HttpTransport({
        endpoint: siteConfig.http.endpoint,
        username: siteConfig.http.username,
        password: siteConfig.http.password,
        logger: this.log,
      });
    }

    throw new Error(`Unknown transport: ${siteConfig.transport}`);
  }
}

module.exports = { ConnectionPool };
