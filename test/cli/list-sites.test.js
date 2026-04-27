'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeHarness, v2SiteOAuth, v2SiteAppPassword } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');

describe('CLI list-sites', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  it('returns empty-state hint when no config exists', async () => {
    const r = await h.runCli('list-sites', []);
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /no sites configured/i);
  });

  it('renders table rows for OAuth + apppassword sites', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteA: v2SiteOAuth('https://siteA.com'),
        siteB: v2SiteAppPassword('https://siteB.com'),
      },
    });
    const r = await h.runCli('list-sites', []);
    assert.equal(r.exitCode, 0);
    const out = r.lines.join('\n');
    assert.match(out, /SITE\s+URL\s+AUTH\s+USER\s+SCOPES\s+EXPIRES\s+STATUS/);
    assert.match(out, /siteA\s+https:\/\/siteA\.com\s+oauth/);
    assert.match(out, /siteB\s+https:\/\/siteB\.com\s+apppassword/);
    assert.match(out, /\(full\)/); // apppassword site shows "(full)" scopes
    assert.match(out, /active/);
  });

  it('decorates OAuth-with-apppassword-fallback rows', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteX: v2SiteOAuth('https://siteX.com', {
          auth: Object.assign({}, v2SiteOAuth('https://siteX.com').auth, {
            apppassword_fallback: { username: 'wp_admin', password_ref: 'keychain://abilities-mcp/siteX/apppassword-legacy' },
          }),
        }),
      },
    });
    const r = await h.runCli('list-sites', []);
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /apppassword-fallback/);
  });

  it('annotates a site with an active force-downgrade audit (H.2.3)', async () => {
    const at = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 25 * 24 * 3600 * 1000).toISOString();
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteY: Object.assign(v2SiteOAuth('https://siteY.com'), {
          oauth_capability_pinned: undefined,
          force_downgrade: { at, expires_at: expiresAt, reason: 'site moved to plan without OAuth' },
        }),
      },
    });
    const r = await h.runCli('list-sites', []);
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /force-downgrade 5d ago/);
    assert.match(r.lines.join('\n'), /site moved to plan/);
  });

  it('hides expired force-downgrade audits', async () => {
    const at = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const expiresAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteZ: Object.assign(v2SiteOAuth('https://siteZ.com'), {
          force_downgrade: { at, expires_at: expiresAt, reason: 'old' },
        }),
      },
    });
    const r = await h.runCli('list-sites', []);
    assert.doesNotMatch(r.lines.join('\n'), /force-downgrade/);
  });
});
