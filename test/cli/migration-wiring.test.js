'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeHarness } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');

/**
 * Integration tests for the bug-23 fix — schema v1→v2 migration is wired into
 * the CLI dispatcher.
 *
 * Per Appendix F.5 (binding): the migration is "Triggered on first bridge
 * launch after upgrade. One-shot, non-destructive." Before #23, neither the
 * MCP server nor any CLI subcommand invoked `migrateFile`, so operators
 * upgrading from v1.4.x got `Config schema is v<unknown> but CLI expects v2`
 * with no documented exit path.
 *
 * These tests drive `runCommand` via the standard CLI harness — same code
 * path the production entrypoint uses, but with `MemorySecretStore` and a
 * tmp config so they never touch real keychain. Bridge-startup migration is
 * covered by the spawn-based test in test/migration-startup.test.js.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

function legacyV1HttpConfig() {
  return {
    defaultSite: 'mysite',
    sites: {
      mysite: {
        label: 'My Site',
        url: 'https://example.com',
        transport: 'http',
        http: {
          endpoint: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server',
          username: 'wp_editor',
          password: 'P@ssw0rd',
        },
      },
    },
  };
}

describe('CLI dispatch — schema v1→v2 migration (bug #23)', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  it('migrates a v1 config in-place before list-sites runs, then list-sites succeeds', async () => {
    // Seed a v1-shaped wp-sites.json — the shape v1.4.x left on disk.
    fs.writeFileSync(h.configPath, JSON.stringify(legacyV1HttpConfig(), null, 2));

    const r = await h.runCli('list-sites', []);

    // The migration banner is surfaced on stdout, then list-sites runs.
    assert.equal(r.exitCode, 0, `exit code ${r.exitCode}; errLines=${r.errLines.join('\n')}`);
    const out = r.lines.join('\n');
    assert.match(out, /Migrated wp-sites\.json v1 → v2/);
    assert.match(out, /1 secret\(s\) lifted/);
    assert.match(out, /mysite/); // list-sites table actually rendered

    // File on disk is now v2.
    const written = JSON.parse(fs.readFileSync(h.configPath, 'utf8'));
    assert.equal(written.schema_version, SCHEMA_VERSION);
    assert.equal(written.sites.mysite.auth.method, 'apppassword');
    assert.equal(written.sites.mysite.auth.username, 'wp_editor');
    assert.match(written.sites.mysite.auth.password_ref, /^keychain:\/\/abilities-mcp\/mysite\/apppassword$/);

    // Backup sits next to the original.
    const backupPath = `${h.configPath}.v1.bak`;
    assert.equal(fs.existsSync(backupPath), true, '.v1.bak should be created');
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(backup.sites.mysite.transport, 'http'); // backup preserves v1 shape
    assert.equal(backup.sites.mysite.http.password, 'P@ssw0rd');

    // Lifted secret landed in the same store the subcommand reads from.
    const stored = await h.ctx.secretStore.get('abilities-mcp', 'mysite/apppassword');
    assert.equal(stored, 'P@ssw0rd');
  });

  it('is idempotent — second invocation against a v2 file does not re-migrate or re-backup', async () => {
    fs.writeFileSync(h.configPath, JSON.stringify(legacyV1HttpConfig(), null, 2));

    // First run migrates.
    const first = await h.runCli('list-sites', []);
    assert.equal(first.exitCode, 0);
    assert.match(first.lines.join('\n'), /Migrated wp-sites\.json v1 → v2/);
    const backupPath = `${h.configPath}.v1.bak`;
    const backupMtime = fs.statSync(backupPath).mtimeMs;

    // Second run is a no-op — no migration banner, file untouched, no second backup overwrite.
    const second = await h.runCli('list-sites', []);
    assert.equal(second.exitCode, 0);
    assert.doesNotMatch(second.lines.join('\n'), /Migrated wp-sites\.json/);
    assert.equal(fs.statSync(backupPath).mtimeMs, backupMtime, '.v1.bak should not be rewritten');
  });

  it('runs migration before upgrade-auth would refuse with v<unknown>', async () => {
    // upgrade-auth on a v1 config used to hit the schema-version refusal in
    // config-store.js. With the migration wired in, it migrates first; then
    // upgrade-auth runs against the migrated v2 config (and rejects for its
    // own reason — the site doesn't exist, or there's no oauth metadata —
    // but importantly, NOT for "schema is v<unknown>").
    fs.writeFileSync(h.configPath, JSON.stringify(legacyV1HttpConfig(), null, 2));

    const r = await h.runCli('upgrade-auth', ['mysite']);
    const errOut = r.errLines.join('\n');
    const stdOut = r.lines.join('\n');

    // Migration banner ran on stdout — schema is no longer v<unknown>.
    assert.match(stdOut, /Migrated wp-sites\.json v1 → v2/);
    assert.doesNotMatch(errOut, /Config schema is v<unknown>/);
    assert.doesNotMatch(errOut, /CLI expects v2/);

    // File is now v2 regardless of whether upgrade-auth subsequently succeeds.
    const written = JSON.parse(fs.readFileSync(h.configPath, 'utf8'));
    assert.equal(written.schema_version, SCHEMA_VERSION);
  });

  it('skips migration when no config file exists (clean install)', async () => {
    // No file at h.configPath — list-sites returns the empty-state hint
    // without erroring on missing file. Migration's ENOENT-safe behavior
    // (returns missing:true, no banner) keeps add-site / list-sites's
    // first-run flow intact.
    const r = await h.runCli('list-sites', []);
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.lines.join('\n'), /Migrated wp-sites\.json/);
  });
});
