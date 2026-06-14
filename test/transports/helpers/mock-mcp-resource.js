'use strict';

const http = require('node:http');
const { URL } = require('node:url');

/**
 * Tiny MCP-resource-shaped HTTP server for transport tests.
 *
 * Validates an `Authorization: Bearer …` header against `acceptedTokens`
 * (a Set). Anything not in the set yields 401 with WWW-Authenticate.
 *
 * Behavior is deterministic and easy to manipulate from tests:
 *   server.acceptedTokens = new Set(['AT-NEW']);   // rotate accepted set
 *   server.config.statusOverride = 503;           // force 5xx
 *   server.config.statusForCount = 2;             // first N requests → override
 *   server.history                                // [{ headers, body, ... }]
 *
 * Defaults: returns a JSON-RPC echo-style response { jsonrpc, id, result: { ok: true } }.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
class MockMcpResource {
  constructor(opts = {}) {
    this.acceptedTokens = new Set(opts.acceptedTokens || ['AT-VALID']);
    this.config = {
      statusOverride: null,
      statusForCount: 0,
      bodyOverride: null,      // string: body to use when statusOverride fires
      successBodyFor: null,    // (req, body) => string
      ...opts.config,
    };
    this.history = [];
    this._server = null;
    this._port = null;
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

  get origin() { return `http://127.0.0.1:${this._port}`; }
  get endpoint() { return `${this.origin}/wp-json/mcp/abilities-mcp-adapter-default-server`; }

  _onRequest(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers['authorization'] || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      this.history.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        bearer,
        body,
      });

      if (this.config.statusOverride && this.config.statusForCount > 0) {
        this.config.statusForCount--;
        res.statusCode = this.config.statusOverride;
        res.setHeader('Content-Type', 'application/json');
        res.end(this.config.bodyOverride || '');
        return;
      }

      if (!bearer || !this.acceptedTokens.has(bearer)) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }

      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* non-JSON */ }
      const id = parsed && parsed.id;
      const responseBody = this.config.successBodyFor
        ? this.config.successBodyFor(req, body)
        : JSON.stringify({ jsonrpc: '2.0', id: id !== undefined ? id : null, result: { ok: true } });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(responseBody);
    });
  }
}

module.exports = { MockMcpResource };
