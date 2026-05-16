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

describe('TokenManager.refresh — retry semantics', () => {
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
    } finally { await server.stop(); }
  });

  it('does NOT retry on 4xx; #89 — a transient invalid_grant while the refresh token is still valid is RETRYABLE and does NOT flip auth_status', async () => {
    // Issue #76/#89: a lone `invalid_grant` can be a transient server-state
    // hiccup. With the refresh token still valid for ~90 days (buildSiteAuth
    // default), it must NOT persist authStatus="expired" — that evidence-free
    // write is exactly what armed the sticky-expired trap. Surface a retryable
    // error and leave auth_status untouched (no `updatedAuth`, no reauth hint).
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
      assert.equal(caught.retryable, true, 'transient: marked retryable');
      assert.equal(caught.updatedAuth, undefined, 'auth_status NOT flipped — no persist trigger (the #89 fix)');
      assert.equal(caught.reauthHint, undefined, 'no reauth hint for a transient');
      assert.match(caught.message, /Transient/i);
      // Still only 1 token-endpoint attempt — no HTTP retry on 4xx.
      assert.equal(server._refreshAttempts, 1);
    } finally { await server.stop(); }
  });

  it('#89 — an explicitly-terminal OAuth error (invalid_client) DOES mark expired + reauth hint', async () => {
    // Strong terminal evidence: the grant is really gone. Preserve the
    // operator-routing terminal behavior regardless of refresh-token expiry.
    const server = await new MockAuthServer({ refresh4xx: { error: 'invalid_client' } }).start();
    try {
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
      const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
      let caught;
      try {
        await tm.refresh(buildSiteAuth({ tokenEndpoint: `${server.origin}/oauth/token` }));
      } catch (err) { caught = err; }
      assert.ok(caught instanceof RefreshError);
      assert.equal(caught.code, 'invalid_client');
      assert.equal(caught.updatedAuth.authStatus, 'expired', 'terminal error → persist expired');
      assert.deepEqual(caught.reauthHint, { siteId: 'siteA', command: 'abilities-mcp reauth siteA' });
      assert.notEqual(caught.retryable, true);
    } finally { await server.stop(); }
  });

  it('#89 Case 4 (genuine expiry preserved) — 4xx with a PAST refresh_token_expires_at marks expired + reauth hint', async () => {
    // The refresh token is genuinely past expiry: even a bare `invalid_grant`
    // is now strong terminal evidence. This is the path the fix must NOT
    // weaken — explicit regression guard.
    const server = await new MockAuthServer({ refresh4xx: { error: 'invalid_grant' } }).start();
    try {
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
      const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
      let caught;
      try {
        await tm.refresh(buildSiteAuth({
          tokenEndpoint: `${server.origin}/oauth/token`,
          refreshTokenExpiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), // expired yesterday
        }));
      } catch (err) { caught = err; }
      assert.ok(caught instanceof RefreshError);
      assert.equal(caught.updatedAuth.authStatus, 'expired', 'genuine expiry → terminal (Case 4 preserved)');
      assert.deepEqual(caught.reauthHint, { siteId: 'siteA', command: 'abilities-mcp reauth siteA' });
      assert.equal(server._refreshAttempts, 1, 'endpoint was attempted (real 4xx is the authority)');
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

  it('does not write a refresh-intent keychain marker (H-7)', async () => {
    // The dead refresh-intent code (a marker written before sending and deleted
    // on every exit path) was removed in PR #20 — server-side encrypt-at-rest
    // grace-window retry (adapter PR #61, v1.4.2) now handles in-flight
    // recovery. Verify no `${siteId}/refresh-intent` entry is ever written
    // during a successful refresh.
    let intentSeenDuringRequest = null;
    const fakePostForm = async () => {
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
    assert.equal(intentSeenDuringRequest, null, 'no refresh-intent marker during request');
    assert.equal(await store.get(SECRET_SERVICE, 'siteA/refresh-intent'), null, 'no refresh-intent marker after success');
  });

  it('#76/#89 — short-circuits on cached authStatus="expired" ONLY when refresh_token_expires_at is genuinely past/missing', async () => {
    // Previously this short-circuited on the cached enum alone (the sticky
    // trap). Corrected condition (#76/#89): the cached "expired" is only
    // believed when the on-disk refresh-token expiry agrees. A past expiry
    // (or a missing one) → short-circuit with the reauth instruction, without
    // hitting the network.
    const tm = new TokenManager({ secretStore: new MemorySecretStore() });
    await assert.rejects(
      tm.refresh(buildSiteAuth({
        authStatus: 'expired',
        refreshTokenExpiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      })),
      (err) => err instanceof RefreshError && err.code === 'reauth_required'
    );
    await assert.rejects(
      tm.refresh(buildSiteAuth({ authStatus: 'expired', refreshTokenExpiresAt: undefined })),
      (err) => err instanceof RefreshError && err.code === 'reauth_required'
    );
  });

  it('#89 Case 1 (the core fix) — cached authStatus="expired" but refresh token still valid → refresh attempts the endpoint and SUCCEEDS, self-heals to active', async () => {
    // The operator incident: a long-past transient flipped the flag while the
    // refresh token is valid for +88d. Pre-fix this threw reauth_required
    // without ever contacting the token endpoint. Post-fix it must attempt
    // the refresh and recover with no manual reauth (matches #76 Path-A live
    // validation: clearing the flag alone was sufficient).
    const server = await new MockAuthServer().start(); // healthy: would 200
    try {
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT-old');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-alive');
      const tm = new TokenManager({ secretStore: store, allowInsecure: true });
      const { tokens, updatedAuth } = await tm.refresh(buildSiteAuth({
        tokenEndpoint: `${server.origin}/oauth/token`,
        authStatus: 'expired',
        refreshTokenExpiresAt: new Date(Date.now() + 88 * 24 * 3600 * 1000).toISOString(),
      }));
      assert.match(tokens.access_token, /^at-/, 'fresh access token issued');
      assert.equal(updatedAuth.authStatus, 'active', 'self-heals: authStatus back to active');
      assert.equal(server._refreshAttempts, 1, 'the token endpoint WAS contacted (no short-circuit)');
    } finally { await server.stop(); }
  });

  it('#89 — REVOKED stays terminal regardless of refresh_token_expires_at', async () => {
    // REVOKED is an explicit terminal state — must not be softened by the
    // expiry-aware path.
    const tm = new TokenManager({ secretStore: new MemorySecretStore() });
    await assert.rejects(
      tm.refresh(buildSiteAuth({
        authStatus: 'revoked',
        refreshTokenExpiresAt: new Date(Date.now() + 88 * 24 * 3600 * 1000).toISOString(),
      })),
      (err) => err instanceof RefreshError && err.code === 'revoked'
    );
  });
});

describe('TokenManager.refresh — #90 opt-in sliding renewal', () => {
  const NINETY_D = 90 * 24 * 3600 * 1000;

  async function freshRefresh(server, clockMs, siteOverrides) {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT-old');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-old');
    const tm = new TokenManager({
      secretStore: store, allowInsecure: true,
      deps: { now: () => clockMs.t },
    });
    return tm.refresh(buildSiteAuth({
      tokenEndpoint: `${server.origin}/oauth/token`,
      ...siteOverrides,
    }));
  }

  it('flag ON — a successful refresh slides refresh_token_expires_at to now+90d; stays alive indefinitely while used', async () => {
    const server = await new MockAuthServer().start();
    try {
      const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
      const frozenIssued = '2026-08-01T00:00:00Z'; // original bounded expiry

      const r1 = await freshRefresh(server, clock, {
        authStatus: 'active', slidingRenewal: true, refreshTokenExpiresAt: frozenIssued,
      });
      assert.equal(r1.updatedAuth.refreshTokenExpiresAt,
        new Date(clock.t + NINETY_D).toISOString(),
        'slid to now+90d (adapter REFRESH_TTL mirror), not the frozen issuance value');
      assert.notEqual(r1.updatedAuth.refreshTokenExpiresAt, frozenIssued);

      // Use it again 60 days later — still within the slid window → slides again.
      clock.t += 60 * 24 * 3600 * 1000;
      const r2 = await freshRefresh(server, clock, {
        authStatus: 'active', slidingRenewal: true,
        refreshTokenExpiresAt: r1.updatedAuth.refreshTokenExpiresAt,
      });
      assert.equal(r2.updatedAuth.refreshTokenExpiresAt,
        new Date(clock.t + NINETY_D).toISOString());
      assert.ok(
        Date.parse(r2.updatedAuth.refreshTokenExpiresAt) > Date.parse(r1.updatedAuth.refreshTokenExpiresAt),
        'window strictly advances on each use → effectively non-expiring while in use'
      );
    } finally { await server.stop(); }
  });

  it('flag OFF (default-preserved guard) — refresh_token_expires_at is BYTE-IDENTICAL across refreshes; no slide, no new write', async () => {
    const server = await new MockAuthServer().start();
    try {
      const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
      const frozenIssued = '2026-08-01T00:00:00Z';

      // Default: flag absent entirely.
      const rAbsent = await freshRefresh(server, clock, {
        authStatus: 'active', refreshTokenExpiresAt: frozenIssued,
      });
      assert.equal(rAbsent.updatedAuth.refreshTokenExpiresAt, frozenIssued,
        'flag absent → unchanged (bounded ~90-days-from-initial-auth preserved)');

      // Explicit false, and a non-true truthy value — both default path.
      clock.t += 10 * 24 * 3600 * 1000;
      const rFalse = await freshRefresh(server, clock, {
        authStatus: 'active', slidingRenewal: false, refreshTokenExpiresAt: frozenIssued,
      });
      assert.equal(rFalse.updatedAuth.refreshTokenExpiresAt, frozenIssued);
      const rTruthy = await freshRefresh(server, clock, {
        authStatus: 'active', slidingRenewal: 1, refreshTokenExpiresAt: frozenIssued,
      });
      assert.equal(rTruthy.updatedAuth.refreshTokenExpiresAt, frozenIssued,
        'strictly === true required — truthy-but-not-true is still default');
    } finally { await server.stop(); }
  });

  it('idle past the window — even with sliding ON, an expired+past site lapses to reauth (#89 path; sliding only acts on a SUCCESSFUL refresh)', async () => {
    const tm = new TokenManager({ secretStore: new MemorySecretStore() });
    await assert.rejects(
      tm.refresh(buildSiteAuth({
        slidingRenewal: true,
        authStatus: 'expired',
        refreshTokenExpiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      })),
      (err) => err instanceof RefreshError && err.code === 'reauth_required'
    );
  });

  it('REVOKED / terminal-4xx unaffected by sliding ON — no slide on a non-success', async () => {
    // REVOKED stays terminal.
    const tm0 = new TokenManager({ secretStore: new MemorySecretStore() });
    await assert.rejects(
      tm0.refresh(buildSiteAuth({
        slidingRenewal: true, authStatus: 'revoked',
        refreshTokenExpiresAt: new Date(Date.now() + 88 * 24 * 3600 * 1000).toISOString(),
      })),
      (err) => err instanceof RefreshError && err.code === 'revoked'
    );
    // Terminal 4xx: still marks expired; sliding never advances expiry on failure.
    const server = await new MockAuthServer({ refresh4xx: { error: 'invalid_client' } }).start();
    try {
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
      const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
      const frozenIssued = '2026-08-01T00:00:00Z';
      let caught;
      try {
        await tm.refresh(buildSiteAuth({
          tokenEndpoint: `${server.origin}/oauth/token`,
          slidingRenewal: true, authStatus: 'active',
          refreshTokenExpiresAt: frozenIssued,
        }));
      } catch (e) { caught = e; }
      assert.equal(caught.code, 'invalid_client', 'explicitly-terminal error');
      assert.equal(caught.updatedAuth.authStatus, 'expired');
      assert.equal(caught.updatedAuth.refreshTokenExpiresAt, frozenIssued,
        'sliding NEVER advances expiry on a failed refresh — only on success');
    } finally { await server.stop(); }
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
