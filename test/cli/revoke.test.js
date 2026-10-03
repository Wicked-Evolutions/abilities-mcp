'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, v2SiteOAuth, v2SiteAppPassword } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { makeRef } = require('../../lib/auth/secret-store');
const { CredentialCoordinator } = require('../../lib/auth/credential-coordinator');
const { TokenManager } = require('../../lib/auth/token-manager');

describe('CLI revoke', () => {
  let server;
  let h;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  beforeEach(async () => {
    h = makeHarness();
    // Seed a configured OAuth site pointing at the mock server. Tokens stored
    // in keychain so revoke can resolve them.
    await h.ctx.secretStore.set('abilities-mcp', 'mock/access', 'AT-MOCK');
    await h.ctx.secretStore.set('abilities-mcp', 'mock/refresh', 'RT-MOCK');
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        mock: Object.assign(v2SiteOAuth(server.siteUrl), {
          auth: Object.assign({}, v2SiteOAuth(server.siteUrl).auth, {
            access_token_ref: makeRef('abilities-mcp', 'mock/access'),
            refresh_token_ref: makeRef('abilities-mcp', 'mock/refresh'),
          }),
        }),
      },
    });
  });
  afterEach(() => h.cleanup());

  it('calls the remote revoke endpoint and clears keychain', async () => {
    server.events.length = 0;
    const r = await h.runCli('revoke', ['mock']);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    // Two POSTs to /oauth/revoke (refresh, then access).
    const revokeCalls = server.events.filter((e) => e.method === 'POST' && e.pathname === '/oauth/revoke');
    assert.equal(revokeCalls.length, 2);
    // Keychain entries deleted.
    assert.equal(await h.ctx.secretStore.get('abilities-mcp', 'mock/access'), null);
    assert.equal(await h.ctx.secretStore.get('abilities-mcp', 'mock/refresh'), null);
    // Config marked revoked.
    const cfg = h.readConfig();
    assert.equal(cfg.sites.mock.auth_status, 'revoked');
  });

  it('refuses a duplicate credential owner before remote revoke or secret deletion', async () => {
    const configured = h.readConfig().sites.mock;
    const identity = CredentialCoordinator.identityForAuth(configured.auth);
    const other = new CredentialCoordinator({
      secretStore: h.ctx.secretStore,
      configPath: `${h.configPath}.duplicate`,
      siteId: 'duplicate',
      deps: { stateRoot: h.ctx.deps.oauthCoordinationStateRoot },
    });
    await other.claimOwnership(identity, 'duplicate');
    server.events.length = 0;

    const r = await h.runCli('revoke', ['mock']);
    assert.notEqual(r.exitCode, 0);
    assert.equal(server.events.filter((event) => event.pathname === '/oauth/revoke').length, 0);
    assert.equal(await h.ctx.secretStore.get('abilities-mcp', 'mock/access'), 'AT-MOCK');
    assert.equal(await h.ctx.secretStore.get('abilities-mcp', 'mock/refresh'), 'RT-MOCK');
  });

  it('recovers a complete prepared refresh and revokes its replacement pair before slot cleanup', async () => {
    const coordinator = new CredentialCoordinator({
      secretStore: h.ctx.secretStore, configPath: h.configPath, siteId: 'mock',
      deps: { stateRoot: h.ctx.deps.oauthCoordinationStateRoot },
    });
    const config = h.readConfig();
    const identity = CredentialCoordinator.identityForAuth(config.sites.mock.auth);
    const committed = await coordinator.preparePair({
      credentialIdentity: identity,
      auth: config.sites.mock.auth,
      tokens: { access_token: 'AT-COMMITTED', refresh_token: 'RT-COMMITTED' },
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    });
    Object.assign(config.sites.mock.auth, committed);
    const prepared = await coordinator.preparePair({
      credentialIdentity: identity,
      auth: committed,
      generation: 'prepared-generation-123456',
      slot: committed.credential_pair_slot === 'a' ? 'b' : 'a',
      tokens: { access_token: 'AT-PREPARED', refresh_token: 'RT-PREPARED' },
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    });
    config.sites.mock.auth.refresh_attempt = {
      nonce: 'prepared-refresh-nonce',
      base_generation: committed.credential_generation,
      credential_identity: identity,
      credential_pair_slot: prepared.credential_pair_slot,
      credential_pair_ref: prepared.credential_pair_ref,
      credential_generation: prepared.credential_generation,
      request_started_at: new Date().toISOString(),
      recovery_deadline_at: new Date(Date.now() + 20_000).toISOString(),
      attempt_count: 1,
      prepared_metadata: {
        access_token_expires_at: prepared.access_token_expires_at,
        refresh_token_expires_at: prepared.refresh_token_expires_at,
        authorization_expires_at: null,
        next_refresh_at: prepared.next_refresh_at,
        refresh_expiry_source: 'authoritative',
      },
    };
    h.writeConfig(config);

    const calls = [];
    const originalRevoke = TokenManager.prototype.revoke;
    TokenManager.prototype.revoke = async function revokeReplacement(args) {
      calls.push(args);
      return { statusCode: 200 };
    };
    try {
      const r = await h.runCli('revoke', ['mock']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    } finally {
      TokenManager.prototype.revoke = originalRevoke;
    }

    assert.deepEqual(calls.map((call) => call.token), ['RT-PREPARED', 'AT-PREPARED']);
    const after = h.readConfig().sites.mock;
    assert.equal(after.auth_status, 'revoked');
    assert.equal(after.auth.refresh_attempt, undefined);
    assert.equal(await h.ctx.secretStore.get('abilities-mcp', new URL(prepared.credential_pair_ref).pathname.slice(1)), null);
  });

  it('errors on apppassword sites', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: { siteB: v2SiteAppPassword('https://siteB.com') },
    });
    const r = await h.runCli('revoke', ['siteB']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /clear-keychain siteB/);
  });

  it('errors on unknown site_id', async () => {
    const r = await h.runCli('revoke', ['ghost']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /unknown site_id/);
  });

  it('skips remote revoke when adapter has no revocation endpoint', async () => {
    // Build a server whose AS metadata omits revocation_endpoint.
    const noRevokeServer = await new MockAuthServer().start();
    const orig = noRevokeServer._asMetadata.bind(noRevokeServer);
    noRevokeServer._asMetadata = function () {
      const m = orig();
      delete m.revocation_endpoint;
      return m;
    };
    try {
      await h.ctx.secretStore.set('abilities-mcp', 'norevoke/access', 'AT-NR');
      await h.ctx.secretStore.set('abilities-mcp', 'norevoke/refresh', 'RT-NR');
      h.writeConfig({
        schema_version: SCHEMA_VERSION,
        sites: {
          norevoke: Object.assign(v2SiteOAuth(noRevokeServer.siteUrl), {
            auth: Object.assign({}, v2SiteOAuth(noRevokeServer.siteUrl).auth, {
              access_token_ref: makeRef('abilities-mcp', 'norevoke/access'),
              refresh_token_ref: makeRef('abilities-mcp', 'norevoke/refresh'),
            }),
          }),
        },
      });
      const r = await h.runCli('revoke', ['norevoke']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      assert.match(r.lines.join('\n'), /skipping remote revocation/);
      // Still cleared keychain.
      assert.equal(await h.ctx.secretStore.get('abilities-mcp', 'norevoke/access'), null);
    } finally {
      await noRevokeServer.stop();
    }
  });
});
