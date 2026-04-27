'use strict';

const http = require('node:http');
const { randomInt } = require('node:crypto');
const { URL } = require('node:url');

const { safeStateEquals } = require('./pkce');
const { StateMismatchError, UserDeniedError, AuthError } = require('./errors');

/**
 * Loopback callback server for the OAuth authorization-code flow.
 *
 * Per Appendix H.4.5 (binding):
 *   - Bind on 127.0.0.1, random high port in [49152, 65535].
 *   - SO_REUSEADDR=false. In Node, that maps to `listen({ exclusive: true })`
 *     — the server will not be shared with other workers and will fail with
 *     EADDRINUSE if the port is already bound.
 *   - State token validates the callback (H.3.5: timingSafeEqual on equal
 *     length, mismatch → reject without exchanging code).
 *
 * Public API:
 *   const server = new LoopbackServer({ expectedState });
 *   const { port, redirectUri } = await server.start();
 *   // → operator browser flow happens
 *   const callback = await server.waitForCallback({ timeoutMs });
 *   // callback = { code, state } | throws StateMismatchError | UserDeniedError | AuthError
 *   await server.stop();
 *
 * The server responds to the browser with a small HTML success or error page
 * depending on the outcome. The callback Promise resolves AFTER the response
 * is flushed so the operator's browser shows the page even if the caller
 * stops the server immediately.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const PORT_MIN = 49_152;
const PORT_MAX = 65_535;
const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 min for operator to complete browser flow
const DEFAULT_BIND_RETRIES = 5;

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authorization complete</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:36rem;margin:6rem auto;padding:0 1.5rem;color:#111}h1{margin:0 0 1rem}p{margin:.25rem 0}</style>
</head><body><h1>Authorization complete</h1>
<p>You can close this tab and return to your terminal.</p></body></html>`;

const DENIED_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authorization denied</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:36rem;margin:6rem auto;padding:0 1.5rem;color:#111}h1{margin:0 0 1rem;color:#a00}p{margin:.25rem 0}</style>
</head><body><h1>Authorization denied</h1>
<p>The site reported that authorization was denied. You can close this tab.</p></body></html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authorization error</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:36rem;margin:6rem auto;padding:0 1.5rem;color:#111}h1{margin:0 0 1rem;color:#a00}p{margin:.25rem 0}</style>
</head><body><h1>Authorization error</h1>
<p>An unexpected response was received. Check your terminal for details.</p></body></html>`;

class LoopbackServer {
  /**
   * @param {object} args
   * @param {string} args.expectedState           Bridge-generated state token
   * @param {string} [args.callbackPath]          Defaults to '/callback'
   * @param {number} [args.bindRetries]
   * @param {(min:number,max:number)=>number} [args.portFn] Test seam.
   */
  constructor(args) {
    if (!args || typeof args.expectedState !== 'string' || args.expectedState.length === 0) {
      throw new Error('LoopbackServer requires expectedState');
    }
    this._expectedState = args.expectedState;
    this._callbackPath = args.callbackPath || '/callback';
    this._bindRetries = args.bindRetries ?? DEFAULT_BIND_RETRIES;
    this._portFn = args.portFn || (() => randomInt(PORT_MIN, PORT_MAX + 1));
    this._server = null;
    this._port = null;
    this._callbackPromise = null;
    this._resolveCallback = null;
    this._rejectCallback = null;
    this._stopped = false;
  }

  /** @returns {{port: number, redirectUri: string}} */
  async start() {
    let lastErr;
    for (let attempt = 0; attempt <= this._bindRetries; attempt++) {
      const port = this._portFn(PORT_MIN, PORT_MAX);
      try {
        await this._listen(port);
        this._port = port;
        return { port, redirectUri: this.redirectUri };
      } catch (err) {
        lastErr = err;
        if (err && err.code !== 'EADDRINUSE') break;
      }
    }
    throw new AuthError(
      `Loopback server failed to bind on a free port after ${this._bindRetries + 1} attempts`,
      { code: 'loopback_bind_failed', cause: lastErr }
    );
  }

  get redirectUri() {
    if (this._port == null) throw new Error('LoopbackServer not started');
    return `http://127.0.0.1:${this._port}${this._callbackPath}`;
  }

  /**
   * Wait for the OAuth provider to redirect the operator's browser to our
   * callback URL. Resolves with `{ code, state }` once a valid callback
   * arrives, or rejects with a typed error.
   *
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{code: string, state: string}>}
   */
  waitForCallback(opts = {}) {
    if (this._callbackPromise) return this._callbackPromise;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._callbackPromise = new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn, value) => {
        if (timer) clearTimeout(timer);
        timer = null;
        this._resolveCallback = null;
        this._rejectCallback = null;
        fn(value);
      };
      this._resolveCallback = (value) => settle(resolve, value);
      this._rejectCallback = (err) => settle(reject, err);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // The settle path clears `timer` to avoid double-clear here.
          this._reject(new AuthError(
            `Loopback callback timed out after ${timeoutMs}ms`,
            { code: 'loopback_timeout', state: 'awaiting_consent' }
          ));
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }
    });
    return this._callbackPromise;
  }

  async stop() {
    this._stopped = true;
    if (!this._server) return;
    await new Promise((resolve) => this._server.close(() => resolve()));
    this._server = null;
  }

  // ---------------------------------------------------------------------

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._onRequest(req, res));
      server.on('error', (err) => {
        if (this._port == null) reject(err);
      });
      // exclusive: true → SO_REUSEADDR=false in Node's worker model. Per
      // Appendix H.4.5 we do not share the port with other listeners.
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        this._server = server;
        resolve();
      });
    });
  }

  _onRequest(req, res) {
    if (this._stopped) {
      res.statusCode = 503;
      res.end();
      return;
    }
    let parsed;
    try { parsed = new URL(req.url, `http://127.0.0.1:${this._port}`); }
    catch {
      this._respond(res, 400, ERROR_HTML);
      return;
    }
    if (parsed.pathname !== this._callbackPath) {
      this._respond(res, 404, ERROR_HTML);
      return;
    }

    const params = parsed.searchParams;
    const error = params.get('error');
    const errorDescription = params.get('error_description');
    const code = params.get('code');
    const receivedState = params.get('state');

    if (error) {
      this._respond(res, 200, error === 'access_denied' ? DENIED_HTML : ERROR_HTML);
      const Cls = error === 'access_denied' ? UserDeniedError : AuthError;
      this._reject(new Cls(
        errorDescription || `Authorization server returned error: ${error}`,
        { code: error, state: 'awaiting_consent' }
      ));
      return;
    }

    if (!code || !receivedState) {
      this._respond(res, 400, ERROR_HTML);
      this._reject(new AuthError(
        'Loopback callback missing code or state',
        { code: 'invalid_callback', state: 'awaiting_consent' }
      ));
      return;
    }

    if (!safeStateEquals(this._expectedState, receivedState)) {
      this._respond(res, 400, ERROR_HTML);
      this._reject(new StateMismatchError(undefined, { state: 'awaiting_consent' }));
      return;
    }

    this._respond(res, 200, SUCCESS_HTML);
    this._resolve({ code, state: receivedState });
  }

  _respond(res, status, html) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
  }

  _resolve(value) {
    if (this._resolveCallback) {
      const fn = this._resolveCallback;
      this._resolveCallback = null;
      this._rejectCallback = null;
      fn(value);
    }
  }

  _reject(err) {
    if (this._rejectCallback) {
      const fn = this._rejectCallback;
      this._resolveCallback = null;
      this._rejectCallback = null;
      fn(err);
    }
  }
}

module.exports = { LoopbackServer, PORT_MIN, PORT_MAX, DEFAULT_TIMEOUT_MS };
