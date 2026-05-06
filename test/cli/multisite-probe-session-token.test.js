'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { BearerJsonRpcClient } = require('../../lib/cli/multisite-probe');

/**
 * BearerJsonRpcClient — per-session HMAC token echo (Issue #54).
 *
 * The adapter's HttpSessionValidator rejects any non-initialize request
 * missing `Mcp-Session-Token` as session-fixation defense. The bridge's
 * one-shot probe client (used by `add-site`) must capture the HMAC from
 * the `initialize` response headers and echo it on every subsequent
 * request — including `notifications/initialized`, the middle of the
 * MCP handshake.
 *
 * The pagination tests in test/cli/multisite-probe.test.js use the
 * function-level `deps.request` injection seam, which bypasses HTTP
 * headers entirely and cannot observe this contract. This file spins up
 * a real local HTTP server, drives BearerJsonRpcClient against it, and
 * asserts on the per-request header sequence captured server-side.
 *
 * Mirrors the protocol-pinning pattern from PR-2 #49 (capturing
 * params.arguments per page-call), but at the HTTP-header layer.
 */

/**
 * Spin up a tiny mock adapter on 127.0.0.1:0. Records every request's
 * method + parsed JSON-RPC body + headers into `received[]`. Returns
 * `Mcp-Session-Id` + `Mcp-Session-Token` headers on the initialize
 * response unless `opts.omitSessionToken === true` (the negative-control
 * case for the conditional-echo proof).
 */
async function startMockAdapter(opts = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(text); } catch { /* ignore */ }
      received.push({ method: body && body.method, body, headers: { ...req.headers } });

      if (body && body.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'test-session-id-abc');
        if (!opts.omitSessionToken) {
          res.setHeader('Mcp-Session-Token', 'test-hmac-token-xyz');
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock-adapter', version: '1' } },
        }));
        return;
      }

      // For non-initialize requests: enforce the session-token contract
      // exactly as the real adapter does, so a bug in the bridge surfaces
      // as a server-side rejection captured in the test (and the assertions
      // below also pin that the required headers were sent).
      if (!opts.omitSessionToken && req.headers['mcp-session-token'] !== 'test-hmac-token-xyz') {
        res.statusCode = 401;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body && body.id, error: { code: -32001, message: 'Unauthorized: Invalid session token' } }));
        return;
      }

      // Notifications get an empty 200; tools/call gets a synthetic OK.
      if (!body || body.method === 'notifications/initialized') {
        res.statusCode = 200;
        res.end('');
        return;
      }
      if (body.method === 'tools/call') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                sites: [
                  { blog_id: 1, domain: 'example.com', path: '/', url: 'https://example.com' },
                  { blog_id: 2, domain: 'a.example.com', path: '/', url: 'https://a.example.com' },
                ],
              }),
            }],
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  return {
    endpoint,
    received,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('BearerJsonRpcClient — Mcp-Session-Token echo (Issue #54)', () => {
  it('echoes Mcp-Session-Token from initialize response on every subsequent request, including notifications/initialized', async () => {
    const adapter = await startMockAdapter();
    try {
      const client = new BearerJsonRpcClient(adapter.endpoint, 'AT-test', () => {});
      await client.initialize();
      await client.callTool('multisite-list-sites', { per_page: 100, page: 1 });

      assert.equal(adapter.received.length, 3,
        'expected exactly 3 requests: initialize → notifications/initialized → tools/call');

      // [0] initialize — neither header is present yet (server hasn't issued either)
      assert.equal(adapter.received[0].method, 'initialize');
      assert.equal(adapter.received[0].headers['mcp-session-id'], undefined);
      assert.equal(adapter.received[0].headers['mcp-session-token'], undefined);

      // [1] notifications/initialized — BOTH headers must be echoed.
      // This is the request the pre-fix code path missed: the notification
      // is sent immediately after initialize but before tools/call. A naive
      // "only echo on the call I care about" fix would still fail here
      // because the adapter validates every non-initialize request.
      assert.equal(adapter.received[1].method, 'notifications/initialized');
      assert.equal(adapter.received[1].headers['mcp-session-id'], 'test-session-id-abc');
      assert.equal(adapter.received[1].headers['mcp-session-token'], 'test-hmac-token-xyz',
        'notifications/initialized MUST echo Mcp-Session-Token (Issue #54 nuance)');

      // [2] tools/call — both headers carry through to subsequent requests.
      assert.equal(adapter.received[2].method, 'tools/call');
      assert.equal(adapter.received[2].headers['mcp-session-id'], 'test-session-id-abc');
      assert.equal(adapter.received[2].headers['mcp-session-token'], 'test-hmac-token-xyz');

      // Client state mirrors what was captured from the server's headers.
      assert.equal(client.sessionId, 'test-session-id-abc');
      assert.equal(client.sessionToken, 'test-hmac-token-xyz');
    } finally {
      await adapter.stop();
    }
  });

  it('omits Mcp-Session-Token when the server does not issue one (conditional echo, not unconditional)', async () => {
    // Negative control — proves the echo is conditional on the server
    // actually returning the header in the initialize response, not an
    // unconditional "always send some value" behavior.
    const adapter = await startMockAdapter({ omitSessionToken: true });
    try {
      const client = new BearerJsonRpcClient(adapter.endpoint, 'AT-test', () => {});
      await client.initialize();
      await client.callTool('multisite-list-sites', { per_page: 100, page: 1 });

      assert.equal(adapter.received.length, 3);
      assert.equal(adapter.received[1].headers['mcp-session-token'], undefined,
        'with no token issued, the bridge must NOT fabricate one');
      assert.equal(adapter.received[2].headers['mcp-session-token'], undefined);
      // Mcp-Session-Id is still echoed since that header was issued.
      assert.equal(adapter.received[1].headers['mcp-session-id'], 'test-session-id-abc');
      assert.equal(client.sessionToken, null,
        'sessionToken stays null when the server does not issue the header');
    } finally {
      await adapter.stop();
    }
  });
});
