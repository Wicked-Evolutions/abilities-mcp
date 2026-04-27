'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, v2SiteOAuth } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { makeRef } = require('../../lib/auth/secret-store');

describe('CLI self-check (H.2.6)', () => {
  let server;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  let h;
  beforeEach(async () => {
    h = makeHarness();
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

  it('reports ✓ when adapter sees the Authorization header', async () => {
    const fakeRequest = async ({ url, headers }) => {
      assert.match(url, /\/wp-json\/abilities-mcp-adapter\/v1\/oauth\/echo-headers$/);
      assert.equal(headers['Authorization'], 'Bearer AT-MOCK');
      return {
        statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}',
        json: { authorization_present: true, host_software: 'Apache/2.4 (cgi)' },
      };
    };
    const r = await h.runCli('self-check', ['mock'], { request: fakeRequest });
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /Authorization header: ✓ Detected/);
    assert.match(r.lines.join('\n'), /Apache\/2\.4/);
  });

  it('reports ⚠ + recovery hints when header is missing — exits non-zero', async () => {
    const fakeRequest = async () => ({
      statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}',
      json: { authorization_present: false, recovery_hints: ['Add the .htaccess RewriteRule'] },
    });
    const r = await h.runCli('self-check', ['mock'], { request: fakeRequest });
    assert.equal(r.exitCode, 4);
    assert.match(r.lines.join('\n'), /⚠ NOT detected/);
    assert.match(r.lines.join('\n'), /\.htaccess RewriteRule/);
  });

  it('handles 404 gracefully (older adapter)', async () => {
    const fakeRequest = async () => ({ statusCode: 404, headers: {}, body: '', json: null });
    const r = await h.runCli('self-check', ['mock'], { request: fakeRequest });
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /does not expose .*echo-headers/);
  });

  it('exit 4 on 401 bearer rejection', async () => {
    const fakeRequest = async () => ({ statusCode: 401, headers: {}, body: '', json: null });
    const r = await h.runCli('self-check', ['mock'], { request: fakeRequest });
    assert.equal(r.exitCode, 4);
    assert.match(r.errLines.join('\n'), /reauth mock/);
  });

  it('errors on apppassword sites', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteB: { url: 'https://siteB.com', auth: { method: 'apppassword', username: 'u', password_ref: 'keychain://abilities-mcp/siteB/apppassword' }, auth_status: 'active' },
      },
    });
    const r = await h.runCli('self-check', ['siteB']);
    assert.equal(r.exitCode, 2);
  });

  it('requires a site_id', async () => {
    const r = await h.runCli('self-check', []);
    assert.equal(r.exitCode, 2);
  });
});
