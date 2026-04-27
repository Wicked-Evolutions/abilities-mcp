'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, autoConsentDeps, v2SiteOAuth, v2SiteAppPassword } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');

describe('CLI reauth', () => {
  let server;
  let h;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });
  beforeEach(() => { h = makeHarness({ deps: { oauthClientDeps: autoConsentDeps() } }); });
  afterEach(() => h.cleanup());

  it('replaces tokens and preserves capabilityPin.first_seen_at', async () => {
    const firstSeen = new Date('2026-01-15T00:00:00.000Z').toISOString();
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        mock: Object.assign(v2SiteOAuth(server.siteUrl), {
          oauth_capability_pinned: { first_seen_at: firstSeen, last_confirmed_at: firstSeen },
        }),
      },
    });
    const r = await h.runCli('reauth', ['mock']);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    const cfg = h.readConfig();
    assert.equal(cfg.sites.mock.auth.method, 'oauth');
    assert.equal(cfg.sites.mock.oauth_capability_pinned.first_seen_at, firstSeen,
      'first_seen_at must survive reauth (H.2.3)');
    assert.notEqual(cfg.sites.mock.oauth_capability_pinned.last_confirmed_at, firstSeen);
    assert.equal(cfg.sites.mock.auth_status, 'active');
  });

  it('errors on unknown site_id', async () => {
    h.writeConfig({ schema_version: SCHEMA_VERSION, sites: {} });
    const r = await h.runCli('reauth', ['ghost']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /unknown site_id "ghost"/);
  });

  it('errors when site uses apppassword (suggests upgrade-auth)', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: { siteB: v2SiteAppPassword('https://siteB.com') },
    });
    const r = await h.runCli('reauth', ['siteB']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /upgrade-auth siteB/);
  });

  it('requires a site_id argument', async () => {
    h.writeConfig({ schema_version: SCHEMA_VERSION, sites: {} });
    const r = await h.runCli('reauth', []);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /requires a site_id/);
  });
});
