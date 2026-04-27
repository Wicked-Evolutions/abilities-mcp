'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, v2SiteOAuth, v2SiteAppPassword } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { makeRef } = require('../../lib/auth/secret-store');

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
