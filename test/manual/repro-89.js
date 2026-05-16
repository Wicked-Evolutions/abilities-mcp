#!/usr/bin/env node
'use strict';

/**
 * Fix-proof harness for issue #89 — sticky auth_status="expired" structural fix.
 *
 * Driven against the bridge's own units (TokenManager + MockAuthServer),
 * offline, deterministic — NOT the MCP path. Pre-fix the audit reported the
 * trap (refresh refused without contacting the endpoint; lone 4xx flips the
 * sticky flag). Post-fix this asserts the corrected behavior per #89's
 * acceptance checkboxes.
 *
 *   A1  refresh() consults refresh_token_expires_at, not just auth_status:
 *       cached "expired" + valid RT → token endpoint IS contacted, succeeds.
 *   A2  auth_status="expired" persist gated on strong evidence: a lone
 *       transient invalid_grant + valid RT → retryable, NO persist trigger.
 *   A4  genuine expiry preserved (Case 4): real 4xx with past RT → terminal,
 *       reauth hint, endpoint attempted. REVOKED stays terminal.
 *
 * Run: node test/manual/repro-89.js   (exit 0 = all proven)
 */

const path = require('node:path');
const assert = require('node:assert/strict');
const { TokenManager, SECRET_SERVICE } = require('../../lib/auth/token-manager');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { makeRef } = require('../../lib/auth/secret-store');
const { AUTH_STATUS } = require('../../lib/auth/events');
const { MockAuthServer } = require('../auth/helpers/mock-auth-server');

const PLUS_88D = new Date(Date.now() + 88 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function siteAuth(server, o = {}) {
  return {
    siteId: 'wickedevolutions',
    tokenEndpoint: `${server.origin}/oauth/token`,
    clientId: 'client-x',
    accessTokenRef: makeRef(SECRET_SERVICE, 'wickedevolutions/access'),
    refreshTokenRef: makeRef(SECRET_SERVICE, 'wickedevolutions/refresh'),
    accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    refreshTokenExpiresAt: PLUS_88D,
    authStatus: AUTH_STATUS.ACTIVE,
    ...o,
  };
}

(async () => {
  // A1 — Case 1: cached "expired" but RT valid → endpoint contacted, succeeds.
  {
    const server = await new MockAuthServer().start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'wickedevolutions/refresh', 'RT-alive');
    const tm = new TokenManager({ secretStore: store, allowInsecure: true });
    const { tokens, updatedAuth } = await tm.refresh(
      siteAuth(server, { authStatus: AUTH_STATUS.EXPIRED, refreshTokenExpiresAt: PLUS_88D })
    );
    assert.match(tokens.access_token, /^at-/);
    assert.equal(updatedAuth.authStatus, AUTH_STATUS.ACTIVE);
    assert.equal(server._refreshAttempts, 1);
    console.log('A1 PROVEN (Case 1): cached auth_status="expired" + refresh_token_expires_at=+88d → token endpoint contacted (_refreshAttempts=1), refresh SUCCEEDS, self-heals to active. The cached enum no longer overrides on-disk validity.');
    await server.stop();
  }

  // A2 — transient invalid_grant + valid RT → retryable, no persist trigger.
  {
    const server = await new MockAuthServer({ refresh4xx: { error: 'invalid_grant', error_description: 'transient' } }).start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'wickedevolutions/refresh', 'RT-alive');
    const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
    let threw = null;
    try { await tm.refresh(siteAuth(server, { authStatus: AUTH_STATUS.ACTIVE, refreshTokenExpiresAt: PLUS_88D })); }
    catch (e) { threw = e; }
    assert.ok(threw && threw.code === 'invalid_grant');
    assert.equal(threw.retryable, true);
    assert.equal(threw.updatedAuth, undefined, 'no updatedAuth → wp-sites.json auth_status NOT flipped');
    console.log('A2 PROVEN: one transient invalid_grant + refresh_token_expires_at=+88d → error.retryable=true, error.updatedAuth=undefined (the persist trigger never fires). The evidence-free arming write is closed.');
    await server.stop();
  }

  // A4 — Case 4 (genuine expiry) preserved + REVOKED terminal.
  {
    const server = await new MockAuthServer({ refresh4xx: { error: 'invalid_grant' } }).start();
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'wickedevolutions/refresh', 'RT-dead');
    const tm = new TokenManager({ secretStore: store, allowInsecure: true, deps: { sleep: () => Promise.resolve() } });
    let threw = null;
    try { await tm.refresh(siteAuth(server, { authStatus: AUTH_STATUS.ACTIVE, refreshTokenExpiresAt: PAST })); }
    catch (e) { threw = e; }
    assert.equal(threw.updatedAuth.authStatus, AUTH_STATUS.EXPIRED);
    assert.deepEqual(threw.reauthHint, { siteId: 'wickedevolutions', command: 'abilities-mcp reauth wickedevolutions' });
    assert.equal(server._refreshAttempts, 1);

    let revokedThrew = null;
    try { await tm.refresh(siteAuth(server, { authStatus: AUTH_STATUS.REVOKED, refreshTokenExpiresAt: PLUS_88D })); }
    catch (e) { revokedThrew = e; }
    assert.equal(revokedThrew.code, 'revoked');
    console.log('A4 PROVEN (Case 4 preserved): real 4xx with past refresh_token_expires_at → terminal (auth_status=expired, reauth hint, endpoint attempted). REVOKED stays terminal regardless of RT expiry.');
    await server.stop();
  }

  console.log('\n#89 fix-proof: A1/A2/A4 corrected; genuine-expiry terminal path preserved. Bridge units only (not the MCP path).');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
