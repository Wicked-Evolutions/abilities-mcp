'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  TokenManager,
  REFRESH_WINDOW_SECONDS,
  SECRET_SERVICE,
} = require('../../lib/auth/token-manager');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { makeRef } = require('../../lib/auth/secret-store');
const { AUTH_STATUS } = require('../../lib/auth/events');
const { RefreshError } = require('../../lib/auth/errors');
const { MockAuthServer } = require('./helpers/mock-auth-server');

function buildSiteAuth(overrides = {}) {
  return {
    siteId: 'siteA',
    tokenEndpoint: 'http://127.0.0.1:1/oauth/token',
    clientId: 'client-x',
    accessTokenRef: makeRef(SECRET_SERVICE, 'siteA/access'),
    refreshTokenRef: makeRef(SECRET_SERVICE, 'siteA/refresh'),
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    authStatus: AUTH_STATUS.ACTIVE,
    ...overrides,
  };
}

describe('TokenManager.getAccessToken — refresh window (H.2.1 + Token-refresh)', () => {
  it('returns the cached access token when outside the 300s refresh window', async () => {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT-cached');
    const tm = new TokenManager({ secretStore: store });
    const result = await tm.getAccessToken(buildSiteAuth());
    assert.equal(result.refreshed, false);
    assert.equal(result.accessToken, 'AT-cached');
  });

  it('refreshes when access token expires inside the window', async () => {
    let server;
    try {
      server = await new MockAuthServer().start();
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT-old');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-old');

      const tm = new TokenManager({ secretStore: store, allowInsecure: true });
      const siteAuth = buildSiteAuth({
        tokenEndpoint: `${server.origin}/oauth/token`,
        accessTokenExpiresAt: new Date(Date.now() + (REFRESH_WINDOW_SECONDS - 60) * 1000).toISOString(),
      });
      const result = await tm.getAccessToken(siteAuth);
      assert.equal(result.refreshed, true);
      assert.match(result.accessToken, /^at-/);
    } finally { if (server) await server.stop(); }
  });
});

describe('TokenManager.refresh — H.2.1 retry semantics', () => {
  it('retries up to 2 times on 5xx with the same refresh token', async () => {
    const server = await new MockAuthServer({ refreshFailures: 2 }).start();
    try {
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-stable');

      const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
      const { tokens, updatedAuth } = await tm.refresh(buildSiteAuth({
        tokenEndpoint: `${server.origin}/oauth/token`,
      }));
      assert.match(tokens.access_token, /^at-/);
      assert.equal(updatedAuth.authStatus, 'active');
      // Server saw 3 attempts (2 failures + 1 success).
      assert.equal(server._refreshAttempts, 3);
      // Intent marker is cleaned up.
      assert.equal(await store.get(SECRET_SERVICE, 'siteA/refresh-intent'), null);
    } finally { await server.stop(); }
  });

  it('does NOT retry on 4xx — surfaces RefreshError + reauth hint, marks expired', async () => {
    const server = await new MockAuthServer({ refresh4xx: { error: 'invalid_grant' } }).start();
    try {
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');

      const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
      let caught;
      try {
        await tm.refresh(buildSiteAuth({ tokenEndpoint: `${server.origin}/oauth/token` }));
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof RefreshError, 'expected RefreshError');
      assert.equal(caught.code, 'invalid_grant');
      assert.equal(caught.updatedAuth.authStatus, 'expired');
      assert.deepEqual(caught.reauthHint, {
        siteId: 'siteA',
        command: 'abilities-mcp reauth siteA',
      });
      // Only 1 attempt — no retry on 4xx.
      assert.equal(server._refreshAttempts, 1);
    } finally { await server.stop(); }
  });

  it('persists rotated refresh token under the same keychain account', async () => {
    const server = await new MockAuthServer().start();
    try {
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT-old');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-old');
      const tm = new TokenManager({ secretStore: store, allowInsecure: true });
      const { updatedAuth } = await tm.refresh(buildSiteAuth({
        tokenEndpoint: `${server.origin}/oauth/token`,
      }));
      const newRT = await store.get(SECRET_SERVICE, 'siteA/refresh');
      assert.notEqual(newRT, 'RT-old');
      assert.equal(updatedAuth.refreshTokenRef, makeRef(SECRET_SERVICE, 'siteA/refresh'));
    } finally { await server.stop(); }
  });

  it('persists intent-to-refresh BEFORE sending request (H.2.1)', async () => {
    let intentSeenDuringRequest = null;
    const fakePostForm = async () => {
      // Capture store contents at the moment the request is in flight.
      intentSeenDuringRequest = await store.get(SECRET_SERVICE, 'siteA/refresh-intent');
      return { statusCode: 200, headers: {}, body: '', json: {
        access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600,
      }};
    };
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const tm = new TokenManager({
      secretStore: store,
      deps: { postForm: fakePostForm, sleep: () => Promise.resolve() },
    });
    await tm.refresh(buildSiteAuth());
    assert.ok(intentSeenDuringRequest, 'intent must be persisted before request');
    // After success, intent is cleared.
    assert.equal(await store.get(SECRET_SERVICE, 'siteA/refresh-intent'), null);
  });

  it('refuses to refresh when authStatus is already expired', async () => {
    const tm = new TokenManager({ secretStore: new MemorySecretStore() });
    await assert.rejects(
      tm.refresh(buildSiteAuth({ authStatus: 'expired' })),
      /reauth_required|expired/i
    );
  });
});

describe('TokenManager.persistTokens', () => {
  it('writes access + refresh and returns refs with computed expiries', async () => {
    const store = new MemorySecretStore();
    const tm = new TokenManager({ secretStore: store, deps: { now: () => 1_700_000_000_000 } });
    const result = await tm.persistTokens({
      siteId: 'siteA',
      tokens: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
    });
    assert.equal(await store.get(SECRET_SERVICE, 'siteA/access'), 'AT');
    assert.equal(await store.get(SECRET_SERVICE, 'siteA/refresh'), 'RT');
    assert.equal(result.accessTokenRef, makeRef(SECRET_SERVICE, 'siteA/access'));
    assert.equal(result.refreshTokenRef, makeRef(SECRET_SERVICE, 'siteA/refresh'));
    assert.equal(result.accessTokenExpiresAt, new Date(1_700_000_000_000 + 3600 * 1000).toISOString());
    assert.equal(result.refreshTokenExpiresAt, new Date(1_700_000_000_000 + 90 * 24 * 3600 * 1000).toISOString());
  });
});

describe('TokenManager.buildPin (Appendix H.2.3)', () => {
  it('preserves first_seen_at across confirmations', () => {
    const tm = new TokenManager({ secretStore: new MemorySecretStore() });
    const initial = tm.buildPin();
    const refreshed = tm.buildPin(initial);
    assert.equal(refreshed.firstSeenAt, initial.firstSeenAt);
    assert.ok(refreshed.lastConfirmedAt);
  });
});
