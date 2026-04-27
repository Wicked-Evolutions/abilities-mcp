'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { randomBytes } = require('node:crypto');

/**
 * Tiny WP-adapter-shaped OAuth 2.1 mock for unit tests.
 *
 * Routes implemented:
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /.well-known/oauth-authorization-server{path}
 *   GET  /.well-known/openid-configuration
 *   GET  /.well-known/openid-configuration{path}
 *   GET  {path}/.well-known/openid-configuration
 *   GET  /.well-known/oauth-protected-resource
 *   GET  /oauth/register     (L2 probe)
 *   POST /oauth/register     (DCR)
 *   GET  /oauth/token        (L2 probe)
 *   POST /oauth/token        (auth code + refresh)
 *   POST /oauth/revoke
 *
 * Behavior is deterministic and easy to manipulate from tests:
 *   server.config.discoveryStatus = 404            // simulate downgrade
 *   server.config.refreshFailures = 2              // 2× 5xx then succeed
 *   server.config.refresh4xx = { error: 'invalid_grant' }
 *
 * The server runs on 127.0.0.1 with an OS-assigned port.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

class MockAuthServer {
  constructor(opts = {}) {
    this.config = {
      discoveryStatus: 200,
      probeFailUntilIndex: -1,         // discovery: -1 = always pass
      registerStatus: 200,
      registerJson: null,
      tokenStatus: 200,
      tokenJson: null,
      refreshFailures: 0,              // 5xx count before success
      refresh4xx: null,                // { error, error_description }
      revokeStatus: 200,
      assertCodeVerifier: null,        // require this verifier on auth code
      sitePath: '',                    // '' or '/site2'
      issueRefreshOnRefresh: true,
      ...opts,
    };
    this._issuedClients = new Map();
    this._issuedCodes = new Map();
    this._issuedRefreshTokens = new Map();
    this._refreshAttempts = 0;

    this._server = null;
    this._port = null;
    this.events = [];
  }

  async start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._onRequest(req, res));
      server.on('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        this._server = server;
        this._port = server.address().port;
        resolve(this);
      });
    });
  }

  async stop() {
    if (!this._server) return;
    await new Promise((resolve) => this._server.close(() => resolve()));
    this._server = null;
  }

  get origin() {
    return `http://127.0.0.1:${this._port}`;
  }
  get siteUrl() {
    return this.origin + (this.config.sitePath || '');
  }

  /** Pre-issue a code (so a test can drive the token exchange directly). */
  issueCode(code, payload) {
    this._issuedCodes.set(code, payload);
  }

  /** Pre-issue a refresh token. */
  issueRefreshToken(token, payload) {
    this._issuedRefreshTokens.set(token, payload);
  }

  // -----------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------

  _onRequest(req, res) {
    const parsed = new URL(req.url, this.origin);
    this.events.push({ method: req.method, pathname: parsed.pathname, search: parsed.search });

    const send = (status, body, headers) => {
      res.statusCode = status;
      const isJson = body && typeof body === 'object';
      const out = isJson ? JSON.stringify(body) : (body || '');
      res.setHeader('Content-Type', isJson ? 'application/json; charset=utf-8' : 'text/plain');
      res.setHeader('Cache-Control', 'no-store');
      if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(out);
    };

    // Discovery
    if (this._isDiscoveryAs(parsed.pathname)) {
      if (this.config.discoveryStatus !== 200) return send(this.config.discoveryStatus, '');
      return send(200, this._asMetadata());
    }
    if (parsed.pathname === '/.well-known/oauth-protected-resource') {
      return send(200, this._prMetadata());
    }

    // OAuth endpoints
    if (parsed.pathname === '/oauth/register' && req.method === 'GET') {
      return send(200, { ok: true, route: 'register' });
    }
    if (parsed.pathname === '/oauth/register' && req.method === 'POST') {
      return this._handleRegister(req, send);
    }
    if (parsed.pathname === '/oauth/token' && req.method === 'GET') {
      return send(200, { ok: true, route: 'token' });
    }
    if (parsed.pathname === '/oauth/token' && req.method === 'POST') {
      return this._handleToken(req, send);
    }
    if (parsed.pathname === '/oauth/revoke' && req.method === 'POST') {
      return send(this.config.revokeStatus, '');
    }
    return send(404, '');
  }

  _isDiscoveryAs(pathname) {
    const candidates = new Set([
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]);
    if (this.config.sitePath) {
      candidates.add(`/.well-known/oauth-authorization-server${this.config.sitePath}`);
      candidates.add(`/.well-known/openid-configuration${this.config.sitePath}`);
      candidates.add(`${this.config.sitePath}/.well-known/openid-configuration`);
    }
    return candidates.has(pathname);
  }

  _asMetadata() {
    return {
      issuer: this.siteUrl,
      authorization_endpoint: `${this.origin}/oauth/authorize`,
      token_endpoint: `${this.origin}/oauth/token`,
      registration_endpoint: `${this.origin}/oauth/register`,
      revocation_endpoint: `${this.origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['abilities:read', 'abilities:write'],
    };
  }
  _prMetadata() {
    return {
      resource: `${this.origin}/wp-json/mcp/mcp-adapter-default-server`,
      authorization_servers: [this.siteUrl],
      scopes_supported: ['abilities:read', 'abilities:write'],
      bearer_methods_supported: ['header'],
    };
  }

  async _readJsonBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); }
        catch { resolve(null); }
      });
    });
  }

  async _readFormBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const params = new URLSearchParams(raw);
        const out = {};
        for (const [k, v] of params.entries()) out[k] = v;
        resolve(out);
      });
    });
  }

  async _handleRegister(req, send) {
    const body = await this._readJsonBody(req);
    if (this.config.registerStatus !== 200 && this.config.registerStatus !== 201) {
      return send(this.config.registerStatus, this.config.registerJson || '');
    }
    const clientId = `client-${randomBytes(8).toString('hex')}`;
    this._issuedClients.set(clientId, { body });
    return send(201, this.config.registerJson || {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body && body.redirect_uris,
      grant_types: body && body.grant_types,
      response_types: body && body.response_types,
      scope: body && body.scope,
      token_endpoint_auth_method: 'none',
      software_id: body && body.software_id,
      software_version: body && body.software_version,
    });
  }

  async _handleToken(req, send) {
    const body = await this._readFormBody(req);
    if (body.grant_type === 'authorization_code') {
      if (this.config.tokenStatus !== 200) {
        return send(this.config.tokenStatus, this.config.tokenJson || { error: 'invalid_grant' });
      }
      if (this.config.assertCodeVerifier && body.code_verifier !== this.config.assertCodeVerifier) {
        return send(400, { error: 'invalid_grant', error_description: 'code_verifier mismatch' });
      }
      const codeData = this._issuedCodes.get(body.code);
      if (!codeData && body.code !== 'AUTOPASS') {
        return send(400, { error: 'invalid_grant', error_description: 'unknown code' });
      }
      const tokens = this.config.tokenJson || {
        access_token: `at-${randomBytes(8).toString('hex')}`,
        refresh_token: `rt-${randomBytes(8).toString('hex')}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'abilities:read abilities:write',
      };
      return send(200, tokens);
    }
    if (body.grant_type === 'refresh_token') {
      this._refreshAttempts++;
      if (this.config.refresh4xx) {
        return send(400, this.config.refresh4xx);
      }
      if (this.config.refreshFailures > 0) {
        this.config.refreshFailures--;
        return send(503, '');
      }
      const tokens = {
        access_token: `at-${randomBytes(8).toString('hex')}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'abilities:read abilities:write',
      };
      if (this.config.issueRefreshOnRefresh) {
        tokens.refresh_token = `rt-${randomBytes(8).toString('hex')}`;
      }
      return send(200, tokens);
    }
    return send(400, { error: 'unsupported_grant_type' });
  }
}

module.exports = { MockAuthServer };
