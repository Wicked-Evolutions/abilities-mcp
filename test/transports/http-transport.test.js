'use strict';

/**
 * HttpTransport — Issue #103 regression tests.
 *
 * Covers:
 *   1. 404 + rest_no_route body → _postWithRetry throws (code mcp_route_absent),
 *      performHandshake is called AT MOST ONCE (proving no unbounded re-handshake loop).
 *   2. 404 without rest_no_route → exactly one re-handshake (existing recovery preserved).
 *
 * Uses a raw http server (no dependency on MockMcpResource) to give precise
 * control over status code and body independently of auth logic.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { HttpTransport } = require('../../lib/transports/http-transport');

/**
 * Starts a minimal HTTP server that always responds with a fixed status + body.
 * Returns { server, origin, stop }.
 */
function startFixedServer(statusCode, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
    });
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const port = server.address().port;
      resolve({
        server,
        origin: `http://127.0.0.1:${port}`,
        stop: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe('HttpTransport — Issue #103: 404 rest_no_route terminates without loop', () => {
  it('404 with rest_no_route body throws mcp_route_absent; performHandshake not called', async () => {
    // The server always returns 404 + rest_no_route regardless of request.
    // If the transport loops, it would call performHandshake which calls
    // _postWithRetry again, which would again 404 → infinite recursion / stack overflow.
    // The fix throws immediately on first 404+rest_no_route so performHandshake
    // is never invoked from _postWithRetry.
    const srv = await startFixedServer(404, JSON.stringify({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } }));
    try {
      const t = new HttpTransport({
        endpoint: `${srv.origin}/wp-json/mcp/v1`,
        username: 'u',
        password: 'p',
        logger: () => {},
      });

      // Spy: count performHandshake calls.
      let handshakeCalls = 0;
      const origHandshake = t.performHandshake.bind(t);
      t.performHandshake = async (...args) => {
        handshakeCalls++;
        return origHandshake(...args);
      };

      // P1 (Issue #103): the terminal throw must NOT be swallowed by the broad
      // network-error catch and retried up to maxRetries. Count raw POSTs — it
      // must be exactly one.
      let postCalls = 0;
      const origPost = t._post.bind(t);
      t._post = async (...args) => { postCalls++; return origPost(...args); };

      // _postWithRetry must throw with code mcp_route_absent.
      await assert.rejects(
        t._postWithRetry(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })),
        (err) => {
          assert.equal(err.code, 'mcp_route_absent', `expected mcp_route_absent, got ${err.code}`);
          assert.equal(err.statusCode, 404);
          assert.match(err.message, /rest_no_route/);
          return true;
        }
      );

      // performHandshake must NOT have been called — that is the loop guard.
      assert.equal(handshakeCalls, 0,
        'performHandshake must not be called when rest_no_route is detected (would loop)');

      // P1: terminal — exactly one POST, not retried as a network error.
      assert.equal(postCalls, 1,
        'rest_no_route must be terminal — exactly one POST, not retried (P1)');
    } finally {
      await srv.stop();
    }
  });

  it('persistent non-rest_no_route 404 converges: exactly one REAL re-handshake, no loop', { timeout: 5000 }, async () => {
    // Server returns a non-rest_no_route 404 on EVERY request, including the
    // re-handshake's own initialize POST. With the REAL performHandshake (not a
    // stub), this is the case that previously looped unbounded: recovery →
    // performHandshake → init POST 404 → recovery → … The Issue #103 _inHandshake
    // guard bounds it to exactly one re-handshake; the outer retry (attempt=1)
    // then skips recovery and returns the 404. The 5s timeout fails fast if the
    // guard regresses (the loop would otherwise hang).
    const srv = await startFixedServer(404, '{}');
    try {
      const t = new HttpTransport({
        endpoint: `${srv.origin}/wp-json/mcp/v1`,
        username: 'u',
        password: 'p',
        logger: () => {},
      });

      // Seed the cached init request so the recovery path can execute.
      t.cachedInitRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

      // Spy that calls through to the REAL performHandshake (which itself POSTs
      // initialize — the recursion path the old no-op stub hid).
      let handshakeCalls = 0;
      const origHandshake = t.performHandshake.bind(t);
      t.performHandshake = async (...args) => { handshakeCalls++; return origHandshake(...args); };

      const result = await t._postWithRetry(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      );

      // Converges, returning the terminal 404 — no throw, no hang.
      assert.equal(result.statusCode, 404);

      // Exactly one real re-handshake — the guard stopped the init POST's 404
      // from spawning further handshakes.
      assert.equal(handshakeCalls, 1,
        'exactly one real re-handshake for a persistent non-rest_no_route 404 (no loop)');
    } finally {
      await srv.stop();
    }
  });
});
