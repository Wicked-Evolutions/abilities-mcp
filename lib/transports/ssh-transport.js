'use strict';

const { spawn, execSync, execFileSync } = require('child_process');

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const MAX_PENDING = 100;

// ---------------------------------------------------------------------------
// Constants (matching mcp-ssh-bridge.js v2.3.0)
// ---------------------------------------------------------------------------

const RECONNECT_MAX_RETRIES  = 10;
const RECONNECT_BASE_DELAY   = 1000;     // 1 second
const RECONNECT_MAX_DELAY    = 30000;    // 30 seconds
const HEALTHCHECK_INTERVAL   = 45000;    // 45 seconds
const HEALTHCHECK_TIMEOUT    = 10000;    // 10 seconds to respond to ping
const REQUEST_TIMEOUT        = 120000;   // 2 minutes per request

/**
 * SSH Transport — connects to a remote WordPress site via SSH + WP-CLI STDIO.
 *
 * Refactored from mcp-ssh-bridge.js v2.3.0. Same resilience features:
 * auto-reconnect, handshake replay, request queuing, healthcheck pings,
 * orphan cleanup, exponential backoff.
 *
 * @fires onMessage(parsedMsg) — when a JSON-RPC response arrives from server
 */
class SshTransport {

  constructor({ host, path, user, mcpServer, subsiteUrl, logger }) {
    this.host = host;
    this.wpPath = path;
    this.wpUser = user || '';
    this.mcpServer = mcpServer || 'mcp-adapter-default-server';
    this.subsiteUrl = subsiteUrl || null;
    this.log = logger || function noop() {};

    // Build WP-CLI command
    this.wpCmd = this._buildWpCmd();

    // SSH child process
    this.child = null;
    this.childReady = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.outputBuffer = '';

    // Handshake cache (set externally by connection pool)
    this.cachedInitializeRequest = null;
    this.cachedInitializedNotification = null;
    this.clientProtocolVersion = null;

    // Request queue + in-flight tracking
    this.pendingRequests = [];
    this.inflightRequests = new Map();
    this.reconnectWaiters = {};

    // Healthcheck
    this.healthcheckTimer = null;
    this.healthcheckPendingId = null;
    this.healthcheckTimeout = null;

    // Shutdown flag
    this.shuttingDown = false;

    // Callback: (parsedMsg: object) => void
    this.onMessage = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Spawn SSH child and optionally replay handshake.
   */
  async connect() {
    this._remoteCleanup();
    this.child = this._spawnChild();
    this.log(`[${this.host}] SSH child spawned`);
  }

  /**
   * Send a JSON-RPC line to this transport's SSH child.
   */
  send(line) {
    if (this.reconnecting) {
      // Queue during reconnection
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.method) {
          this.log(`[${this.host}] Queuing request ${msg.id} (${msg.method}) — reconnecting`);
          this._queueOrReject(line);
        }
      } catch (e) {
        this._queueOrReject(line);
      }
      return;
    }

    if (this.child && this.childReady && !this.child.killed) {
      try {
        this.child.stdin.write(line + '\n');
        this._trackInflight(line);
      } catch (e) {
        this.log(`[${this.host}] Write failed: ${e.message}`);
        this._queueOrReject(line);
      }
    } else if (this.child && !this.child.killed && !this.childReady) {
      // Child exists but not ready — queue non-init messages
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          this.child.stdin.write(line + '\n');
        } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
          this.child.stdin.write(line + '\n');
          this.childReady = true;
          this.log(`[${this.host}] childReady set via client-driven handshake`);
          this._drainPendingRequests();
          this._startHealthcheck();
        } else if (msg.id !== undefined && msg.method) {
          this._queueOrReject(line);
        }
      } catch (e) {
        this._queueOrReject(line);
      }
    } else {
      // No child — queue
      this._queueOrReject(line);
    }
  }

  /**
   * Graceful shutdown — kill child, remote cleanup.
   */
  async shutdown() {
    this.shuttingDown = true;
    this._stopHealthcheck();
    this._safeKillChild();
    this._remoteCleanup();
  }

  isReady() {
    return this.childReady && !this.reconnecting && !this.shuttingDown;
  }

  /**
   * Perform MCP initialize handshake on this transport.
   * Called by the connection pool for lazy-connected sites.
   * Returns the initialize response (parsed JSON-RPC object).
   */
  async performHandshake(initReq, initializedNotif) {
    this.cachedInitializeRequest = initReq;
    this.cachedInitializedNotification = initializedNotif;
    if (initReq.params && initReq.params.protocolVersion) {
      this.clientProtocolVersion = initReq.params.protocolVersion;
    }

    // Send initialize request
    const initLine = JSON.stringify(initReq) + '\n';
    this.child.stdin.write(initLine);
    this.log(`[${this.host}] HANDSHAKE > SERVER: initialize (id=${initReq.id})`);

    // Wait for response
    const response = await this._waitForResponse(initReq.id, 15000);
    if (!response) {
      throw new Error(`No initialize response from ${this.host} within 15s`);
    }

    // Rewrite protocol version if needed
    if (response.result && response.result.protocolVersion && this.clientProtocolVersion) {
      response.result.protocolVersion = this.clientProtocolVersion;
    }

    // Send initialized notification
    if (initializedNotif) {
      const notifLine = JSON.stringify(initializedNotif) + '\n';
      this.child.stdin.write(notifLine);
      this.log(`[${this.host}] HANDSHAKE > SERVER: initialized`);
    }

    this.childReady = true;
    this._drainPendingRequests();
    this._startHealthcheck();

    return response;
  }

  // ---------------------------------------------------------------------------
  // SSH child process management
  // ---------------------------------------------------------------------------

  _buildWpCmd() {
    let cmd = `cd ${this.wpPath} && timeout 2h wp mcp-adapter serve --server=${this.mcpServer}`;
    if (this.subsiteUrl) {
      cmd += ` --url=${this.subsiteUrl}`;
    }
    if (this.wpUser) {
      cmd += ` --user=${this.wpUser}`;
    }
    cmd += ' 2>/dev/null';
    return cmd;
  }

  _spawnChild() {
    this.log(`[${this.host}] Spawning: ssh -T ${this.host} '${this.wpCmd}'`);

    const proc = spawn('ssh', [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      this.host,
      this.wpCmd,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr.on('data', (chunk) => {
      this.log(`[${this.host}] SSH STDERR: ${chunk.toString().trim()}`);
    });

    proc.on('error', (err) => {
      this.log(`[${this.host}] Child spawn error: ${err.message}`);
      this._handleChildDeath(-1);
    });

    proc.on('close', (code) => {
      this.log(`[${this.host}] Child exited with code ${code}`);
      if (proc === this.child) {
        this._handleChildDeath(code);
      }
    });

    proc.stdout.on('data', (chunk) => {
      this._handleChildStdout(chunk);
    });

    return proc;
  }

  _handleChildDeath(code) {
    this.childReady = false;
    this._stopHealthcheck();

    // Fail any in-flight requests
    for (const [id, timer] of this.inflightRequests) {
      clearTimeout(timer);
      this._sendError(id, -32603, 'Server connection lost, reconnecting...');
    }
    this.inflightRequests.clear();

    if (this.shuttingDown) return;
    if (this.reconnecting) return;

    this.log(`[${this.host}] Child died (code ${code}), reconnecting`);
    this._attemptReconnect();
  }

  // ---------------------------------------------------------------------------
  // Reconnection with exponential backoff
  // ---------------------------------------------------------------------------

  async _attemptReconnect() {
    this.reconnecting = true;

    while (this.reconnectAttempts < RECONNECT_MAX_RETRIES && !this.shuttingDown) {
      this.reconnectAttempts++;
      const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1),
        RECONNECT_MAX_DELAY
      );
      this.log(`[${this.host}] Reconnect ${this.reconnectAttempts}/${RECONNECT_MAX_RETRIES} after ${delay}ms`);

      await this._sleep(delay);
      if (this.shuttingDown) break;

      try {
        this.child = this._spawnChild();
        this.outputBuffer = '';

        if (this.cachedInitializeRequest) {
          this.log(`[${this.host}] Replaying handshake`);

          const initReq = JSON.stringify(this.cachedInitializeRequest) + '\n';
          this.child.stdin.write(initReq);

          const initResponse = await this._waitForResponse(this.cachedInitializeRequest.id, 15000);
          if (!initResponse) {
            this.log(`[${this.host}] No init response during reconnect`);
            this._safeKillChild();
            continue;
          }

          if (initResponse.result && initResponse.result.protocolVersion && this.clientProtocolVersion) {
            initResponse.result.protocolVersion = this.clientProtocolVersion;
          }

          if (this.cachedInitializedNotification) {
            const notif = JSON.stringify(this.cachedInitializedNotification) + '\n';
            this.child.stdin.write(notif);
          }

          this.childReady = true;
          this.reconnectAttempts = 0;
          this.reconnecting = false;
          this.log(`[${this.host}] Reconnect successful`);

          this._drainPendingRequests();
          this._startHealthcheck();
          return;
        } else {
          this.childReady = true;
          this.reconnectAttempts = 0;
          this.reconnecting = false;
          this.log(`[${this.host}] Reconnect successful (pre-init)`);
          return;
        }
      } catch (err) {
        this.log(`[${this.host}] Reconnect attempt failed: ${err.message}`);
        this._safeKillChild();
      }
    }

    if (!this.shuttingDown) {
      this.log(`[${this.host}] All reconnect attempts exhausted`);
      // Fail pending requests
      for (const req of this.pendingRequests) {
        try {
          const msg = JSON.parse(req.raw);
          if (msg.id !== undefined) {
            this._sendError(msg.id, -32603, 'Server connection lost after all reconnect attempts');
          }
        } catch (e) { /* ignore */ }
      }
      this.pendingRequests = [];
      this.reconnecting = false;
    }
  }

  _waitForResponse(id, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        delete this.reconnectWaiters[id];
        resolve(null);
      }, timeoutMs);

      this.reconnectWaiters[id] = (msg) => {
        clearTimeout(timer);
        delete this.reconnectWaiters[id];
        resolve(msg);
      };
    });
  }

  _safeKillChild() {
    try {
      if (this.child && !this.child.killed) {
        this.child.kill('SIGTERM');
      }
    } catch (e) {
      this.log(`[${this.host}] Error killing child: ${e.message}`);
    }
    this.child = null;
    this.childReady = false;
  }

  _remoteCleanup() {
    try {
      let killPattern = this.wpPath + '.*mcp-adapter serve --server=' + this.mcpServer;
      if (this.subsiteUrl) {
        killPattern += '.*--url=' + this.subsiteUrl;
      }
      const remoteCmd = `pkill -f ${shellQuote(killPattern)}`;
      this.log(`[${this.host}] Remote cleanup: ${remoteCmd}`);
      execFileSync('ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        this.host,
        remoteCmd,
      ], {
        timeout: 10000,
        stdio: 'ignore',
      });
    } catch (e) {
      this.log(`[${this.host}] Remote cleanup finished (exit: ${e.status || 'unknown'})`);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Pending request queue
  // ---------------------------------------------------------------------------

  _queueOrReject(line) {
    if (this.pendingRequests.length >= MAX_PENDING) {
      this.log(`[${this.host}] Pending queue full — rejecting`);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.onMessage) {
          this.onMessage(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32603, message: 'Transport queue full' }
          }));
        }
      } catch (e) { /* ignore */ }
      return;
    }
    this.pendingRequests.push({ raw: line });
  }

  _drainPendingRequests() {
    if (this.pendingRequests.length === 0) return;
    this.log(`[${this.host}] Draining ${this.pendingRequests.length} pending request(s)`);

    const queued = this.pendingRequests.slice();
    this.pendingRequests = [];

    for (const req of queued) {
      if (this.child && this.childReady) {
        this.child.stdin.write(req.raw + '\n');
        this._trackInflight(req.raw);
      } else {
        this.pendingRequests.push(req);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // In-flight request tracking
  // ---------------------------------------------------------------------------

  _trackInflight(rawLine) {
    try {
      const msg = JSON.parse(rawLine);
      if (msg.id !== undefined && msg.method) {
        const timer = setTimeout(() => {
          this.log(`[${this.host}] Request ${msg.id} timed out after ${REQUEST_TIMEOUT}ms`);
          this.inflightRequests.delete(msg.id);
          this._sendError(msg.id, -32603, `Request timed out after ${REQUEST_TIMEOUT / 1000}s`);
        }, REQUEST_TIMEOUT);
        this.inflightRequests.set(msg.id, timer);
      }
    } catch (e) { /* not JSON */ }
  }

  _resolveInflight(id) {
    const timer = this.inflightRequests.get(id);
    if (timer) {
      clearTimeout(timer);
      this.inflightRequests.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Healthcheck
  // ---------------------------------------------------------------------------

  _startHealthcheck() {
    this._stopHealthcheck();
    this.healthcheckTimer = setInterval(() => {
      if (!this.child || !this.childReady || this.reconnecting) return;
      this._sendPing();
    }, HEALTHCHECK_INTERVAL);
  }

  _stopHealthcheck() {
    if (this.healthcheckTimer) { clearInterval(this.healthcheckTimer); this.healthcheckTimer = null; }
    if (this.healthcheckTimeout) { clearTimeout(this.healthcheckTimeout); this.healthcheckTimeout = null; }
    this.healthcheckPendingId = null;
  }

  _sendPing() {
    this.healthcheckPendingId = `__bridge_ping_${Date.now()}`;
    const ping = JSON.stringify({ jsonrpc: '2.0', id: this.healthcheckPendingId, method: 'ping' }) + '\n';

    try {
      this.child.stdin.write(ping);
    } catch (e) {
      this.log(`[${this.host}] Ping write failed: ${e.message}`);
      this._handleChildDeath(-1);
      return;
    }

    this.healthcheckTimeout = setTimeout(() => {
      this.log(`[${this.host}] Healthcheck timed out`);
      this.healthcheckPendingId = null;
      this._safeKillChild();
      this._handleChildDeath(-1);
    }, HEALTHCHECK_TIMEOUT);
  }

  // ---------------------------------------------------------------------------
  // Child stdout processing
  // ---------------------------------------------------------------------------

  _handleChildStdout(chunk) {
    this.outputBuffer += chunk.toString();

    let newlineIdx;
    while ((newlineIdx = this.outputBuffer.indexOf('\n')) !== -1) {
      const line = this.outputBuffer.slice(0, newlineIdx);
      this.outputBuffer = this.outputBuffer.slice(newlineIdx + 1);

      if (!line.trim()) continue;

      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        // Not valid JSON — forward as-is
        if (this.onMessage) this.onMessage(null, line);
        continue;
      }

      // Internal: healthcheck pong
      if (msg.id && msg.id === this.healthcheckPendingId) {
        this.log(`[${this.host}] Healthcheck pong received`);
        if (this.healthcheckTimeout) { clearTimeout(this.healthcheckTimeout); this.healthcheckTimeout = null; }
        this.healthcheckPendingId = null;
        continue;
      }

      // Internal: reconnect handshake waiter
      if (msg.id !== undefined && this.reconnectWaiters[msg.id]) {
        this.reconnectWaiters[msg.id](msg);
        continue;
      }

      // Resolve in-flight tracking
      if (msg.id !== undefined && !msg.method) {
        this._resolveInflight(msg.id);
      }

      // Protocol version rewriting
      if (this.clientProtocolVersion && msg.result && msg.result.protocolVersion) {
        msg.result.protocolVersion = this.clientProtocolVersion;
      }

      // Forward to callback
      if (this.onMessage) {
        this.onMessage(msg, JSON.stringify(msg));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Error helper
  // ---------------------------------------------------------------------------

  _sendError(id, code, message) {
    if (this.onMessage) {
      this.onMessage({
        jsonrpc: '2.0',
        id: id,
        error: { code, message },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Static: SSH_AUTH_SOCK discovery (call once from main)
  // ---------------------------------------------------------------------------

  static ensureSshAuthSock() {
    if (process.env.SSH_AUTH_SOCK) return;
    try {
      const sock = execSync('launchctl getenv SSH_AUTH_SOCK', { encoding: 'utf8' }).trim();
      if (sock) {
        process.env.SSH_AUTH_SOCK = sock;
      }
    } catch (e) {
      // Not on macOS or launchd not available — fine
    }
  }
}

module.exports = { SshTransport };
