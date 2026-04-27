'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeHarness, v2SiteOAuth } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { AUDIT_RETENTION_DAYS } = require('../../lib/cli/commands/force-downgrade');

describe('CLI force-downgrade (H.2.3)', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  function seed() {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteA: v2SiteOAuth('https://siteA.com'),
      },
    });
  }

  it('refuses without --i-understand-the-risk', async () => {
    seed();
    const r = await h.runCli('force-downgrade', ['siteA']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /--i-understand-the-risk/);
    // Audit not written
    const cfg = h.readConfig();
    assert.equal(cfg.sites.siteA.force_downgrade, undefined);
    assert.ok(cfg.sites.siteA.oauth_capability_pinned);
  });

  it('clears the pin and writes a 30-day audit record', async () => {
    seed();
    const before = Date.now();
    const r = await h.runCli('force-downgrade', [
      'siteA',
      '--i-understand-the-risk',
      '--reason=site lost OAuth after host migration',
    ]);
    assert.equal(r.exitCode, 0);
    const cfg = h.readConfig();
    assert.equal(cfg.sites.siteA.oauth_capability_pinned, undefined);
    assert.ok(cfg.sites.siteA.force_downgrade);
    assert.equal(cfg.sites.siteA.force_downgrade.reason, 'site lost OAuth after host migration');
    const at = Date.parse(cfg.sites.siteA.force_downgrade.at);
    const expiresAt = Date.parse(cfg.sites.siteA.force_downgrade.expires_at);
    assert.ok(at >= before);
    assert.ok(expiresAt - at >= AUDIT_RETENTION_DAYS * 24 * 3600 * 1000 - 5);
  });

  it('idempotent on a non-pinned site', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteB: Object.assign(v2SiteOAuth('https://siteB.com'), { oauth_capability_pinned: undefined }),
      },
    });
    const r = await h.runCli('force-downgrade', ['siteB', '--i-understand-the-risk']);
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /not OAuth-pinned/);
    // No audit written.
    assert.equal(h.readConfig().sites.siteB.force_downgrade, undefined);
  });

  it('errors on unknown site_id', async () => {
    seed();
    const r = await h.runCli('force-downgrade', ['ghost', '--i-understand-the-risk']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /unknown site_id/);
  });
});
