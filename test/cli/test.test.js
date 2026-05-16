'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, v2SiteOAuth, v2SiteAppPassword } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { makeRef } = require('../../lib/auth/secret-store');

describe('CLI test (ping + scope summary)', () => {
  let server;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  let h;
  beforeEach(async () => {
    h = makeHarness();
    await h.ctx.secretStore.set('abilities-mcp', 'mock/access', 'AT-MOCK');
    await h.ctx.secretStore.set('abilities-mcp', 'mock/refresh', 'RT-MOCK');
  });
  afterEach(() => h.cleanup());

  function seed(extra = {}) {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        mock: Object.assign(v2SiteOAuth(server.siteUrl), {
          auth: Object.assign({}, v2SiteOAuth(server.siteUrl).auth, {
            access_token_ref: makeRef('abilities-mcp', 'mock/access'),
            refresh_token_ref: makeRef('abilities-mcp', 'mock/refresh'),
          }, extra.auth || {}),
          mcp_resource: extra.mcp_resource || `${server.origin}/wp-json/mcp/mcp-adapter-default-server`,
        }),
      },
    });
  }

  it('returns 0 + reports scopes when adapter ping succeeds', async () => {
    seed();
    // Inject a fake `request` so we don't actually need an MCP endpoint on
    // the mock — the test focuses on bearer plumbing.
    let seenAuth;
    const fakeRequest = async ({ headers, url }) => {
      seenAuth = headers && headers['Authorization'];
      assert.match(url, /\/wp-json\/mcp\//);
      return { statusCode: 200, headers: {}, body: '{}', json: { ok: true } };
    };
    const r = await h.runCli('test', ['mock'], { request: fakeRequest });
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.match(seenAuth, /^Bearer AT-MOCK$/);
    assert.match(r.lines.join('\n'), /Reachable/);
    assert.match(r.lines.join('\n'), /Granted scopes:/);
  });

  it('refreshes within window and persists new expiry', async () => {
    // Seed with an expired access token so getAccessToken refreshes.
    const past = new Date(Date.now() - 1000).toISOString();
    seed({ auth: { access_token_expires_at: past } });
    const fakeRequest = async () => ({ statusCode: 200, headers: {}, body: '{}', json: {} });
    const r = await h.runCli('test', ['mock'], { request: fakeRequest });
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.match(r.lines.join('\n'), /Refreshed access token/);
    // expires_at on the config moved forward.
    const cfg = h.readConfig();
    assert.notEqual(cfg.sites.mock.auth.access_token_expires_at, past);
  });

  it('marks site auth_status=expired on a terminal 4xx refresh', async () => {
    // #89: a bare `invalid_grant` while the refresh token is still valid is
    // now treated as transient (retryable, no persist). This test's intent is
    // the terminal path — use an explicitly-terminal OAuth error so it still
    // exercises "terminal 4xx → auth_status=expired + reauth instruction".
    const past = new Date(Date.now() - 1000).toISOString();
    server.config.refresh4xx = { error: 'invalid_client' };
    seed({ auth: { access_token_expires_at: past } });
    const fakeRequest = async () => ({ statusCode: 200, headers: {}, body: '{}', json: {} });
    const r = await h.runCli('test', ['mock'], { request: fakeRequest });
    server.config.refresh4xx = null;       // restore
    assert.equal(r.exitCode, 4);
    assert.match(r.errLines.join('\n'), /reauth mock/);
    const cfg = h.readConfig();
    assert.equal(cfg.sites.mock.auth_status, 'expired');
  });

  it('errors on apppassword sites', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: { siteB: v2SiteAppPassword('https://siteB.com') },
    });
    const r = await h.runCli('test', ['siteB']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /OAuth bearer authentication only/);
  });

  it('returns auth-error exit (4) when bearer is rejected', async () => {
    seed();
    const fakeRequest = async () => ({ statusCode: 401, headers: {}, body: '', json: null });
    const r = await h.runCli('test', ['mock'], { request: fakeRequest });
    assert.equal(r.exitCode, 4);
    assert.match(r.errLines.join('\n'), /reauth mock/);
  });

  it('requires a site_id', async () => {
    seed();
    const r = await h.runCli('test', []);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /requires a site_id/);
  });
});
