'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { OAuthHttpTransport } = require('../../lib/transports/oauth-http-transport');
const { TokenManager, SECRET_SERVICE, REFRESH_WINDOW_SECONDS } = require('../../lib/auth/token-manager');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { makeRef } = require('../../lib/auth/secret-store');
const { AUTH_STATUS } = require('../../lib/auth/events');
const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { MockMcpResource } = require('./helpers/mock-mcp-resource');

/**
 * OAuthHttpTransport — runtime bearer + refresh on 401 (Issue #17).
 *
 * Coverage:
 *   1. Bearer header construction with the resolved access token
 *   2. Pre-expiry refresh (300s window per H.2.1) fires before the request
 *   3. 401 → forceRefresh → retry succeeds with new token
 *   4. 401 → forceRefresh → retry still 401 → typed error, auth_status=expired,
 *      no third attempt
 *   5. 5xx retry on transport-level errors does not double-mint tokens
 */

function buildSiteAuth(server, overrides = {}) {
  return {
    siteId: 'siteA',
    tokenEndpoint: `${server.origin}/oauth/token`,
    clientId: 'client-x',
    accessTokenRef: makeRef(SECRET_SERVICE, 'siteA/access'),
    refreshTokenRef: makeRef(SECRET_SERVICE, 'siteA/refresh'),
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    authStatus: AUTH_STATUS.ACTIVE,
    ...overrides,
  };
}

async function buildStack({ accessToken = 'AT-OK', acceptTokens, expiresInSec = 3600 } = {}) {
  const server = await new MockAuthServer().start();
  const resource = await new MockMcpResource({
    acceptedTokens: acceptTokens || [accessToken],
  }).start();
  const store = new MemorySecretStore();
  await store.set(SECRET_SERVICE, 'siteA/access', accessToken);
  await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-OK');

  const tm = new TokenManager({
    secretStore: store, allowInsecure: true,
    deps: { sleep: () => Promise.resolve() },
  });

  const siteAuth = buildSiteAuth(server, {
    accessTokenExpiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  });

  return { server, resource, store, tm, siteAuth };
}

function send(transport, line) {
  return new Promise((resolve) => {
    transport.onMessage = (parsedMsg, rawLine) => resolve({ parsedMsg, rawLine });
    transport.send(line);
  });
}

describe('OAuthHttpTransport — bearer header construction', () => {
  it('attaches Authorization: Bearer <token> built from TokenManager', async () => {
    const { server, resource, tm, siteAuth } = await buildStack({ accessToken: 'AT-CACHED' });
    try {
      const t = new OAuthHttpTransport({
        endpoint: resource.endpoint, tokenManager: tm, siteAuth, logger: () => {},
      });
      await t.connect();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const result = await send(t, req);
      assert.equal(result.parsedMsg && result.parsedMsg.result && result.parsedMsg.result.ok, true);

      const seen = resource.history[0];
      assert.equal(seen.bearer, 'AT-CACHED');
      assert.equal(seen.headers['authorization'], 'Bearer AT-CACHED');
      // The original request body is what we POSTed.
      assert.match(seen.body, /"method":"tools\/list"/);
      await t.shutdown();
    } finally {
      await server.stop(); await resource.stop();
    }
  });
});

describe('OAuthHttpTransport — pre-expiry refresh (H.2.1, 300s window)', () => {
  it('refreshes when access_token_expires_at is inside the 300s window, then uses the new token', async () => {
    // Seed the resource to accept ONLY the freshly-minted token. The cached
    // 'AT-OLD' must not work — proving the transport refreshed.
    const server = await new MockAuthServer().start();
    server.config.tokenJson = {
      access_token: 'AT-NEW-ROTATED',
      refresh_token: 'RT-NEW-ROTATED',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    const resource = await new MockMcpResource({ acceptedTokens: ['AT-NEW-ROTATED'] }).start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT-OLD');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-OLD');
    const tm = new TokenManager({
      secretStore: store, allowInsecure: true,
      deps: { sleep: () => Promise.resolve() },
    });
    const siteAuth = buildSiteAuth(server, {
      // Inside the 300s window — TokenManager will refresh on getAccessToken.
      accessTokenExpiresAt: new Date(Date.now() + (REFRESH_WINDOW_SECONDS - 60) * 1000).toISOString(),
    });

    try {
      const t = new OAuthHttpTransport({
        endpoint: resource.endpoint, tokenManager: tm, siteAuth, logger: () => {},
      });
      await t.connect();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
      const result = await send(t, req);
      assert.ok(result.parsedMsg.result, 'expected success');
      // The bearer the resource saw must be the newly-rotated one.
      const seen = resource.history[0];
      assert.equal(seen.bearer, 'AT-NEW-ROTATED');
      // Token endpoint was hit exactly once by the pre-expiry refresh.
      assert.equal(server._refreshAttempts, 1);
      await t.shutdown();
    } finally {
      await server.stop(); await resource.stop();
    }
  });
});

describe('OAuthHttpTransport — #90 opt-in sliding renewal (guardrail 1: no new write path for flag-off)', () => {
  async function refreshOnce(siteOverrides) {
    const server = await new MockAuthServer().start();
    server.config.tokenJson = {
      access_token: 'AT-NEW', refresh_token: 'RT-NEW', token_type: 'Bearer', expires_in: 3600,
    };
    const resource = await new MockMcpResource({ acceptedTokens: ['AT-NEW'] }).start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT-OLD');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-OLD');
    const tm = new TokenManager({
      secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() },
    });
    const siteAuth = buildSiteAuth(server, {
      accessTokenExpiresAt: new Date(Date.now() + (REFRESH_WINDOW_SECONDS - 60) * 1000).toISOString(),
      ...siteOverrides,
    });
    const renewed = [];
    const t = new OAuthHttpTransport({
      endpoint: resource.endpoint, tokenManager: tm, siteAuth, logger: () => {},
      onTokensRenewed: (ua) => renewed.push(ua),
    });
    try {
      await t.connect();
      const r = await send(t, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
      assert.ok(r.parsedMsg.result, 'refresh + request succeeded');
      assert.equal(server._refreshAttempts, 1, 'a real refresh happened');
      await t.shutdown();
      return renewed;
    } finally { await server.stop(); await resource.stop(); }
  }

  it('flag OFF (absent / false / non-true) — successful refresh does NOT invoke onTokensRenewed (no new write path)', async () => {
    assert.deepEqual(await refreshOnce({}), [], 'flag absent → callback never fires');
    assert.deepEqual(await refreshOnce({ slidingRenewal: false }), [], 'flag false → callback never fires');
    assert.deepEqual(await refreshOnce({ slidingRenewal: 1 }), [], 'truthy-but-not-true → still default, callback never fires');
  });

  it('flag ON — successful refresh invokes onTokensRenewed once with the slid expiry + rotated refs', async () => {
    const renewed = await refreshOnce({ slidingRenewal: true });
    assert.equal(renewed.length, 1, 'callback fired exactly once on the successful refresh');
    const ua = renewed[0];
    assert.equal(ua.authStatus, 'active');
    assert.ok(Date.parse(ua.refreshTokenExpiresAt) > Date.now() + 80 * 24 * 3600 * 1000,
      'slid forward ~90d (adapter REFRESH_TTL mirror)');
    assert.ok(ua.accessTokenRef && ua.refreshTokenRef, 'rotated refs carried for persistence');
  });
});

describe('OAuthHttpTransport — 401 → forceRefresh → retry-once', () => {
  it('on 401 from resource, force-refreshes once and retries with the new token', async () => {
    const server = await new MockAuthServer().start();
    server.config.tokenJson = {
      access_token: 'AT-AFTER-REFRESH',
      refresh_token: 'RT-AFTER-REFRESH',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    // Resource accepts only the post-refresh token.
    const resource = await new MockMcpResource({ acceptedTokens: ['AT-AFTER-REFRESH'] }).start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT-STALE');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-STALE');
    const tm = new TokenManager({
      secretStore: store, allowInsecure: true,
      deps: { sleep: () => Promise.resolve() },
    });
    // Comfortably outside the refresh window — only the 401 should trigger refresh.
    const siteAuth = buildSiteAuth(server);

    try {
      const t = new OAuthHttpTransport({
        endpoint: resource.endpoint, tokenManager: tm, siteAuth, logger: () => {},
      });
      await t.connect();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
      const result = await send(t, req);
      assert.equal(result.parsedMsg && result.parsedMsg.result && result.parsedMsg.result.ok, true);

      // The resource saw at least two requests: stale → 401, then fresh → 200.
      const bearersSeen = resource.history.map((h) => h.bearer);
      assert.deepEqual(
        bearersSeen.slice(0, 2),
        ['AT-STALE', 'AT-AFTER-REFRESH'],
        `expected stale-then-fresh bearer sequence, got ${JSON.stringify(bearersSeen)}`
      );
      // Exactly one refresh was performed — not two.
      assert.equal(server._refreshAttempts, 1);
      await t.shutdown();
    } finally {
      await server.stop(); await resource.stop();
    }
  });
});

describe('OAuthHttpTransport — terminal 401 after refresh', () => {
  it('second 401 with a freshly-minted token surfaces typed error, sets auth_status=expired, no third attempt', async () => {
    const server = await new MockAuthServer().start();
    server.config.tokenJson = {
      access_token: 'AT-DOA',           // dead-on-arrival; resource will reject
      refresh_token: 'RT-NEW',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    const resource = await new MockMcpResource({ acceptedTokens: ['AT-NEVER-VALID'] }).start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT-STALE');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const tm = new TokenManager({
      secretStore: store, allowInsecure: true,
      deps: { sleep: () => Promise.resolve() },
    });
    const siteAuth = buildSiteAuth(server);

    let observedStatusChange = null;
    const t = new OAuthHttpTransport({
      endpoint: resource.endpoint, tokenManager: tm, siteAuth, logger: () => {},
      onAuthStatusChange: (newStatus, info) => {
        observedStatusChange = { newStatus, info };
      },
    });
    try {
      await t.connect();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
      const result = await send(t, req);

      // The transport surfaces a structured error to the caller.
      assert.ok(result.parsedMsg && result.parsedMsg.error, 'expected error on terminal 401');
      assert.match(
        String(result.parsedMsg.error.message || ''),
        /OAuth bearer rejected|reauth siteA/,
        `error must mention reauth: ${JSON.stringify(result.parsedMsg.error)}`,
      );

      // Resource was hit exactly twice (initial + retry-after-refresh). NO third.
      assert.equal(resource.history.length, 2, 'expected exactly two attempts at the resource');
      // Token endpoint was hit exactly once (the forced refresh).
      assert.equal(server._refreshAttempts, 1);
      // auth_status_change was emitted with 'expired'.
      assert.ok(observedStatusChange, 'expected onAuthStatusChange callback to fire');
      assert.equal(observedStatusChange.newStatus, 'expired');
      assert.equal(observedStatusChange.info.siteId, 'siteA');
    } finally {
      await t.shutdown(); await server.stop(); await resource.stop();
    }
  });

  it('a refresh that 4xxs with a terminal error surfaces error and emits onAuthStatusChange(expired)', async () => {
    // #89: bare `invalid_grant` + still-valid refresh token is now transient
    // (no auth_status flip). This test asserts the terminal persist path —
    // drive it with an explicitly-terminal OAuth error.
    const server = await new MockAuthServer({
      refresh4xx: { error: 'invalid_client' },
    }).start();
    const resource = await new MockMcpResource({ acceptedTokens: ['AT-NOT-USED'] }).start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const tm = new TokenManager({
      secretStore: store, allowInsecure: true,
      deps: { sleep: () => Promise.resolve() },
    });
    // Force the refresh-window path so getAccessToken hits the token endpoint.
    const siteAuth = buildSiteAuth(server, {
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    let observed = null;
    const t = new OAuthHttpTransport({
      endpoint: resource.endpoint, tokenManager: tm, siteAuth, logger: () => {},
      onAuthStatusChange: (newStatus, info) => { observed = { newStatus, info }; },
    });
    try {
      await t.connect();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
      const result = await send(t, req);
      assert.ok(result.parsedMsg && result.parsedMsg.error);
      assert.match(String(result.parsedMsg.error.message), /OAuth refresh failed|reauth/);
      assert.ok(observed);
      assert.equal(observed.newStatus, 'expired');
    } finally {
      await t.shutdown(); await server.stop(); await resource.stop();
    }
  });
});

describe('OAuthHttpTransport — surface compatibility with HttpTransport', () => {
  it('exposes endpoint, isReady, onMessage, send, connect, shutdown', () => {
    const t = new OAuthHttpTransport({
      endpoint: 'http://127.0.0.1:1/mcp',
      tokenManager: { getAccessToken: () => Promise.resolve({ accessToken: 'X', refreshed: false }) },
      siteAuth: { siteId: 'x' },
    });
    assert.equal(typeof t.connect, 'function');
    assert.equal(typeof t.send, 'function');
    assert.equal(typeof t.isReady, 'function');
    assert.equal(typeof t.performHandshake, 'function');
    assert.equal(typeof t.shutdown, 'function');
    assert.equal(t.endpoint, 'http://127.0.0.1:1/mcp');
    assert.equal(t.isReady(), false);
  });
});

describe('OAuthHttpTransport — multisite subsite header (Issue #48)', () => {
  it('forwards X-Abilities-MCP-Subsite-URL on every POST when subsiteUrl is set', async () => {
    const { server, resource, tm, siteAuth } = await buildStack({ accessToken: 'AT-OK' });
    try {
      const t = new OAuthHttpTransport({
        endpoint: resource.endpoint,
        subsiteUrl: 'https://community.example.com',
        tokenManager: tm, siteAuth, logger: () => {},
      });
      await t.connect();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      await send(t, req);
      const seen = resource.history[0];
      assert.equal(
        seen.headers['x-abilities-mcp-subsite-url'],
        'https://community.example.com',
        'subsite URL header is forward-looking infrastructure for path-style ' +
        'multisite (Phase B); subdomain-style routing already works via the endpoint URL'
      );
      await t.shutdown();
    } finally {
      await server.stop(); await resource.stop();
    }
  });

  it('omits the subsite header when subsiteUrl is not set (single-site OAuth)', async () => {
    const { server, resource, tm, siteAuth } = await buildStack({ accessToken: 'AT-OK' });
    try {
      const t = new OAuthHttpTransport({
        endpoint: resource.endpoint, tokenManager: tm, siteAuth, logger: () => {},
      });
      await t.connect();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      await send(t, req);
      const seen = resource.history[0];
      assert.equal(seen.headers['x-abilities-mcp-subsite-url'], undefined,
        'no subsite URL → no subsite header (single-site OAuth path unchanged)');
      await t.shutdown();
    } finally {
      await server.stop(); await resource.stop();
    }
  });
});
