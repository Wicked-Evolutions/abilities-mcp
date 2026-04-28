'use strict';

/**
 * H-8: OAuthClient._runRegister must never return a persisted client_id.
 *
 * Pre-fix: _runRegister called identityProvider.getClientId() and, if a value
 * was returned, short-circuited and reused it without verifying that the
 * registered loopback redirect_uri's port matched the live loopback port.
 *
 * v1.0 was safe by accident — FreshEachTimeIdentityProvider.getClientId()
 * always returns null. v1.1 (Option C, persistent client_id per Appendix
 * H.3.2) would have surfaced the bug: a stale persisted client_id whose
 * server-side registered redirect_uri pinned a port no longer in use would
 * cause the next /oauth/authorize to fail redirect_uri_valid().
 *
 * After fix: _runRegister calls identityProvider.clearClientId(siteUrl)
 * before DCR (defensive — v1.0 no-op; v1.1+ implementations get a chance to
 * remove a stale entry) and never reuses a persisted client_id from this
 * code path. Reuse paths that already know their loopback port matches the
 * registration must short-circuit at OAuthClient.run() level instead.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { OAuthClient } = require('../../lib/auth/oauth-client');
const { FreshEachTimeIdentityProvider } = require('../../lib/auth/fresh-each-time-identity');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { MockAuthServer } = require('./helpers/mock-auth-server');

/**
 * Identity provider that simulates a v1.1+ implementation:
 *   - getClientId returns whatever value setUp picked (defaulting to a stale
 *     "previously persisted" value).
 *   - clearClientId / persistClientId record their calls so tests can assert.
 */
class RecordingIdentityProvider {
  constructor({ initialClientId = null } = {}) {
    this._clientId = initialClientId;
    this.calls = {
      getClientId: 0,
      clearClientId: 0,
      persistClientId: 0,
    };
    this.persistedAfterDcr = null;
  }

  async getClientId(_siteId) {
    this.calls.getClientId++;
    return this._clientId;
  }

  async clearClientId(_siteId) {
    this.calls.clearClientId++;
    this._clientId = null;
  }

  async persistClientId(_siteId, clientId) {
    this.calls.persistClientId++;
    this.persistedAfterDcr = clientId;
    this._clientId = clientId;
  }

  async exportIdentity(_siteId) { return null; }
  async importIdentity(_siteId, _bundle) {
    const e = new Error('not supported in test'); e.code = 'not_implemented'; throw e;
  }
}

function autoCompleteFlow(client, code = 'AUTOPASS') {
  client.on('awaiting_consent', ({ data }) => {
    const url = new URL(data.authorizeUrl);
    const state = url.searchParams.get('state');
    const cbUrl = `${data.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    setImmediate(() => {
      http.get(cbUrl, (res) => res.resume()).on('error', () => {});
    });
  });
}

describe('OAuthClient — H-8 client_id port guard', () => {
  let server;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  it('clears any persisted client_id before DCR (defensive — v1.0 no-op, v1.1+ scrub)', async () => {
    const idp = new RecordingIdentityProvider({ initialClientId: 'cl_stale_from_prior_run' });
    const client = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: idp,
      allowInsecure: true,
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(client);

    const result = await client.run();

    // clearClientId must run before DCR.
    assert.ok(idp.calls.clearClientId >= 1, 'clearClientId must be called at least once before DCR');
    // Fresh DCR must run — persistClientId fires after the DCR succeeds.
    assert.equal(idp.calls.persistClientId, 1, 'persistClientId must be called exactly once (post-DCR)');
    // The result client_id must be the freshly-minted one, NOT the stale persisted value.
    assert.notEqual(result.clientId, 'cl_stale_from_prior_run', 'must not reuse the stale persisted client_id');
    assert.match(result.clientId, /^client-/, 'must be the freshly-minted client_id from MockAuthServer');
  });

  it('does NOT reuse a persisted client_id even when getClientId returns one', async () => {
    // The strong guarantee: regardless of what getClientId returns, _runRegister
    // never short-circuits to that value. Reuse paths must live elsewhere.
    const idp = new RecordingIdentityProvider({ initialClientId: 'cl_attacker_or_stale' });
    const client = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: idp,
      allowInsecure: true,
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(client);

    const result = await client.run();

    assert.notEqual(result.clientId, 'cl_attacker_or_stale');
    // The fresh DCR must have happened — persistClientId fires once with the new id.
    assert.equal(idp.calls.persistClientId, 1);
    assert.equal(idp.persistedAfterDcr, result.clientId);
  });

  it('clearClientId is called even when getClientId would have returned null (idempotent guard)', async () => {
    // Even with an empty starting state (matching v1.0 FreshEachTime), the
    // defensive clear must still fire — it's the contract that v1.1+ providers
    // hook into.
    const idp = new RecordingIdentityProvider({ initialClientId: null });
    const client = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: idp,
      allowInsecure: true,
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(client);

    await client.run();

    assert.ok(idp.calls.clearClientId >= 1, 'defensive clearClientId must fire even on empty initial state');
  });

  it('v1.0 regression: FreshEachTimeIdentityProvider still produces fresh DCR each run', async () => {
    const idp = new FreshEachTimeIdentityProvider({ store: new MemorySecretStore() });

    const c1 = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: idp,
      allowInsecure: true,
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(c1);
    const r1 = await c1.run();

    const c2 = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: idp,
      allowInsecure: true,
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(c2);
    const r2 = await c2.run();

    // Both runs minted fresh client_ids.
    assert.match(r1.clientId, /^client-/);
    assert.match(r2.clientId, /^client-/);
    assert.notEqual(r1.clientId, r2.clientId, 'v1.0 must mint a fresh client_id every run');
  });
});
