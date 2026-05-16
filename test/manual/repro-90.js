#!/usr/bin/env node
'use strict';

/**
 * Fix-proof harness for issue #90 — opt-in silent sliding-renewal OAuth.
 *
 * Bridge units only (TokenManager + OAuthHttpTransport + MockAuthServer /
 * MockMcpResource), offline, deterministic — NOT the MCP path.
 *
 *   G1  flag ON  → a successful refresh slides refresh_token_expires_at to
 *       now+90d (adapter REFRESH_TTL mirror); strictly advances on each use →
 *       effectively non-expiring while actively used.
 *   G2  flag OFF (default-preserved guard) → refresh_token_expires_at is
 *       BYTE-IDENTICAL across refreshes; no slide.
 *   G3  idle past the window → still lapses to reauth via the #89 path
 *       (sliding acts only on a SUCCESSFUL refresh); REVOKED stays terminal.
 *   G4  guardrail 1 — flag OFF never invokes the persist callback
 *       (no new write path); flag ON invokes it exactly once.
 *
 * Run: node test/manual/repro-90.js   (exit 0 = all proven)
 */

const assert = require('node:assert/strict');
const { TokenManager, SECRET_SERVICE, REFRESH_WINDOW_SECONDS } = require('../../lib/auth/token-manager');
const { OAuthHttpTransport } = require('../../lib/transports/oauth-http-transport');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { makeRef } = require('../../lib/auth/secret-store');
const { AUTH_STATUS } = require('../../lib/auth/events');
const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { MockMcpResource } = require('../transports/helpers/mock-mcp-resource');

const NINETY_D = 90 * 24 * 3600 * 1000;

function siteAuth(server, o = {}) {
  return {
    siteId: 'siteA',
    tokenEndpoint: `${server.origin}/oauth/token`,
    clientId: 'client-x',
    accessTokenRef: makeRef(SECRET_SERVICE, 'siteA/access'),
    refreshTokenRef: makeRef(SECRET_SERVICE, 'siteA/refresh'),
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    refreshTokenExpiresAt: '2026-08-01T00:00:00Z',
    authStatus: AUTH_STATUS.ACTIVE,
    ...o,
  };
}

(async () => {
  // G1 — flag ON slides + strictly advances.
  {
    const server = await new MockAuthServer().start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
    const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { now: () => clock.t } });
    const r1 = await tm.refresh(siteAuth(server, { slidingRenewal: true }));
    assert.equal(r1.updatedAuth.refreshTokenExpiresAt, new Date(clock.t + NINETY_D).toISOString());
    clock.t += 60 * 24 * 3600 * 1000;
    const r2 = await tm.refresh(siteAuth(server, { slidingRenewal: true, refreshTokenExpiresAt: r1.updatedAuth.refreshTokenExpiresAt }));
    assert.ok(Date.parse(r2.updatedAuth.refreshTokenExpiresAt) > Date.parse(r1.updatedAuth.refreshTokenExpiresAt));
    console.log('G1 PROVEN: flag ON → refresh slides refresh_token_expires_at to now+90d and strictly advances on each use (non-expiring while actively used).');
    await server.stop();
  }

  // G2 — flag OFF byte-identical (absent / false / non-true).
  {
    const server = await new MockAuthServer().start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const tm = new TokenManager({ secretStore: store, allowInsecure: true });
    const frozen = '2026-08-01T00:00:00Z';
    for (const o of [{}, { slidingRenewal: false }, { slidingRenewal: 1 }]) {
      const r = await tm.refresh(siteAuth(server, { ...o, refreshTokenExpiresAt: frozen }));
      assert.equal(r.updatedAuth.refreshTokenExpiresAt, frozen);
    }
    console.log('G2 PROVEN: flag OFF (absent/false/non-true) → refresh_token_expires_at BYTE-IDENTICAL across refreshes (default bounded behavior preserved).');
    await server.stop();
  }

  // G3 — idle-past-window lapses via #89; REVOKED terminal even with flag ON.
  {
    const tm = new TokenManager({ secretStore: new MemorySecretStore() });
    let a = null, b = null;
    try { await tm.refresh(siteAuth({ origin: 'http://x' }, { slidingRenewal: true, authStatus: 'expired', refreshTokenExpiresAt: new Date(Date.now() - 1e3).toISOString() })); } catch (e) { a = e; }
    try { await tm.refresh(siteAuth({ origin: 'http://x' }, { slidingRenewal: true, authStatus: 'revoked', refreshTokenExpiresAt: new Date(Date.now() + NINETY_D).toISOString() })); } catch (e) { b = e; }
    assert.equal(a.code, 'reauth_required');
    assert.equal(b.code, 'revoked');
    console.log('G3 PROVEN: sliding ON does NOT bypass #89 — idle-past-window lapses to reauth_required; REVOKED stays terminal.');
  }

  // G4 — guardrail 1: persist callback gated on flag.
  {
    async function refreshOnce(o) {
      const server = await new MockAuthServer().start();
      server.config.tokenJson = { access_token: 'AT-NEW', refresh_token: 'RT-NEW', token_type: 'Bearer', expires_in: 3600 };
      const resource = await new MockMcpResource({ acceptedTokens: ['AT-NEW'] }).start();
      const store = new MemorySecretStore();
      await store.set(SECRET_SERVICE, 'siteA/access', 'AT-OLD');
      await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT-OLD');
      const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
      const sa = siteAuth(server, { accessTokenExpiresAt: new Date(Date.now() + (REFRESH_WINDOW_SECONDS - 60) * 1000).toISOString(), ...o });
      const renewed = [];
      const t = new OAuthHttpTransport({ endpoint: resource.endpoint, tokenManager: tm, siteAuth: sa, logger: () => {}, onTokensRenewed: (ua) => renewed.push(ua) });
      await t.connect();
      await new Promise((res) => { t.onMessage = res; t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })); });
      await t.shutdown(); await server.stop(); await resource.stop();
      return renewed.length;
    }
    assert.equal(await refreshOnce({}), 0);
    assert.equal(await refreshOnce({ slidingRenewal: false }), 0);
    assert.equal(await refreshOnce({ slidingRenewal: true }), 1);
    console.log('G4 PROVEN: flag OFF never invokes the persist callback (no new write path — guardrail 1); flag ON invokes it exactly once.');
  }

  console.log('\n#90 fix-proof: opt-in sliding renewal correct; default bounded behavior byte-identical; #89 lapse + REVOKED preserved. Bridge units only (not the MCP path).');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
