'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, autoConsentDeps, v2SiteAppPassword } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { makeRef } = require('../../lib/auth/secret-store');

describe('CLI upgrade-auth (Appendix F.5)', () => {
  let server;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  let h;
  beforeEach(async () => {
    h = makeHarness({ deps: { oauthClientDeps: autoConsentDeps() } });
    // Seed a site that's currently using App Password.
    await h.ctx.secretStore.set('abilities-mcp', 'siteX/apppassword', 'OLD-APP-PASSWORD');
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteX: Object.assign(v2SiteAppPassword(server.siteUrl), {
          auth: {
            method: 'apppassword',
            username: 'wp_admin',
            password_ref: makeRef('abilities-mcp', 'siteX/apppassword'),
          },
        }),
      },
    });
  });
  afterEach(() => h.cleanup());

  it('Step 2+3 succeed, fallback retained, exit 0 with binding spec wording', async () => {
    // Provide a fake request fn for Step 3 ping.
    const fakeRequest = async () => ({ statusCode: 200, headers: {}, body: '{}', json: {} });
    const r = await h.runCli('upgrade-auth', ['siteX'], { request: fakeRequest });
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    const out = r.lines.join('\n');
    // Spec-binding wording (F.5):
    assert.match(out, /✓ OAuth working\. App Password kept as fallback for now\./);

    const cfg = h.readConfig();
    assert.equal(cfg.sites.siteX.auth.method, 'oauth');
    assert.ok(cfg.sites.siteX.auth.apppassword_fallback);
    assert.equal(cfg.sites.siteX.auth.apppassword_fallback.username, 'wp_admin');
    assert.match(
      cfg.sites.siteX.auth.apppassword_fallback.password_ref,
      /^keychain:\/\/abilities-mcp\/siteX\/apppassword-legacy$/
    );
    // The legacy keychain entry has the old value preserved.
    const legacy = await h.ctx.secretStore.get('abilities-mcp', 'siteX/apppassword-legacy');
    assert.equal(legacy, 'OLD-APP-PASSWORD');
  });

  it('keeps the original fallback ref when the legacy keychain copy fails', async () => {
    const originalGet = h.ctx.secretStore.get.bind(h.ctx.secretStore);
    h.ctx.secretStore.get = async (service, account) => {
      if (service === 'abilities-mcp' && account === 'siteX/apppassword') {
        const err = new Error('security find-generic-password timed out');
        err.code = 'security_cli_timeout';
        throw err;
      }
      return originalGet(service, account);
    };

    const fakeRequest = async () => ({ statusCode: 200, headers: {}, body: '{}', json: {} });
    const r = await h.runCli('upgrade-auth', ['siteX'], { request: fakeRequest });
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.match(
      r.lines.join('\n'),
      /Could not copy App Password fallback to a legacy keychain entry; keeping existing fallback reference/
    );

    const cfg = h.readConfig();
    assert.equal(cfg.sites.siteX.auth.method, 'oauth');
    assert.equal(
      cfg.sites.siteX.auth.apppassword_fallback.password_ref,
      'keychain://abilities-mcp/siteX/apppassword'
    );
    const legacy = await originalGet('abilities-mcp', 'siteX/apppassword-legacy');
    assert.equal(legacy, null);
  });

  it('--confirm strips the fallback and deletes legacy keychain entry', async () => {
    // Run Step 2+3 first to set up the fallback state.
    const fakeRequest = async () => ({ statusCode: 200, headers: {}, body: '{}', json: {} });
    let r = await h.runCli('upgrade-auth', ['siteX'], { request: fakeRequest });
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));

    // Now confirm.
    r = await h.runCli('upgrade-auth', ['siteX', '--confirm']);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    // Spec-binding wording:
    assert.match(
      r.lines.join('\n'),
      /✓ Migration complete\. App Password removed\. Site siteX now uses OAuth only\./
    );
    const cfg = h.readConfig();
    assert.equal(cfg.sites.siteX.auth.apppassword_fallback, undefined);
    const legacy = await h.ctx.secretStore.get('abilities-mcp', 'siteX/apppassword-legacy');
    assert.equal(legacy, null);
  });

  it('reverts on Step 3 ping failure and surfaces "✗ OAuth test failed — reverting." (binding wording)', async () => {
    const fakeRequest = async () => ({ statusCode: 401, headers: {}, body: '', json: null });
    const r = await h.runCli('upgrade-auth', ['siteX'], { request: fakeRequest });
    assert.equal(r.exitCode, 4);
    // Binding wording.
    assert.match(r.lines.join('\n'), /✗ OAuth test failed — reverting\./);
    const cfg = h.readConfig();
    // Reverted to apppassword.
    assert.equal(cfg.sites.siteX.auth.method, 'apppassword');
  });

  it('Step 1 pre-flight fails with binding wording when adapter has no OAuth', async () => {
    const downgraded = await new MockAuthServer({ discoveryStatus: 404 }).start();
    try {
      h.writeConfig({
        schema_version: SCHEMA_VERSION,
        sites: {
          siteX: Object.assign(v2SiteAppPassword(downgraded.siteUrl), {
            auth: {
              method: 'apppassword',
              username: 'wp_admin',
              password_ref: makeRef('abilities-mcp', 'siteX/apppassword'),
            },
          }),
        },
      });
      const r = await h.runCli('upgrade-auth', ['siteX']);
      assert.equal(r.exitCode, 4);
      assert.match(
        r.errLines.join('\n'),
        /Site siteX does not have OAuth\. Install abilities-mcp-adapter v1\.5\.0\+ first\./
      );
    } finally {
      await downgraded.stop();
    }
  });

  it('idempotent on a site already fully migrated', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteY: {
          url: 'https://siteY.com',
          label: 'Y',
          auth: {
            method: 'oauth',
            client_id: 'cid',
            user_login: 'wp_admin',
            scopes: ['abilities:read'],
            access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
            access_token_ref: 'keychain://abilities-mcp/siteY/access',
            refresh_token_ref: 'keychain://abilities-mcp/siteY/refresh',
          },
          auth_status: 'active',
        },
      },
    });
    const r = await h.runCli('upgrade-auth', ['siteY']);
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /already uses OAuth/);
  });

  it('errors on unknown site_id', async () => {
    h.writeConfig({ schema_version: SCHEMA_VERSION, sites: {} });
    const r = await h.runCli('upgrade-auth', ['ghost']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /unknown site_id/);
  });
});
