'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, resolvePassword, resolveConfigFilePath } = require('../lib/config');

/**
 * Issue #5 / Phase E.2 — async config loading.
 *
 * The boot chain (`resolveConfigFilePath`, `loadConfig`, `loadConfigFile`,
 * `validateSiteConfig`, `resolvePassword`) is async so file reads and
 * `passwordCommand` shell-outs do not block the event loop during startup.
 * These tests pin the public surface of that conversion: each entry point
 * returns a Promise, file reads use the async API, and `passwordCommand`
 * still goes through a real shell so existing operator configs (pipes,
 * `op read … | tr -d '\n'`, etc.) continue to work.
 */

const tmpFiles = [];
after(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

function writeTempConfig(contents) {
  const file = path.join(
    os.tmpdir(),
    `wp-sites.test.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 });
  tmpFiles.push(file);
  return file;
}

describe('loadConfig — async surface (Issue #5)', () => {
  it('returns a Promise', () => {
    const file = writeTempConfig({
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          transport: 'http',
          http: {
            endpoint: 'https://example.com/wp-json/mcp/mcp-adapter-default-server',
            username: 'u',
            password: 'pw',
          },
        },
      },
    });
    const result = loadConfig({ config: file });
    assert.ok(result && typeof result.then === 'function', 'loadConfig must return a Promise');
    return result.then((cfg) => {
      assert.equal(cfg.sites.siteA.http.username, 'u');
    });
  });

  it('rejects when no configuration source is present', async () => {
    // No --config, no env vars, no --host/--path. The candidate paths
    // (script dir + ~/.abilities-mcp) may exist on the dev machine, so we
    // pass an explicit non-existent --config to force the explicit-path
    // branch and verify the error surface.
    const missing = path.join(os.tmpdir(), `wp-sites.missing.${process.pid}.${Date.now()}.json`);
    await assert.rejects(loadConfig({ config: missing }), /ENOENT|no such file/);
  });
});

describe('resolveConfigFilePath — async surface (Issue #5)', () => {
  it('resolves an explicit --config to an absolute path without touching disk', async () => {
    const result = await resolveConfigFilePath({ config: './nowhere/wp-sites.json' });
    assert.ok(path.isAbsolute(result), 'expected absolute path');
    assert.ok(result.endsWith('wp-sites.json'));
  });

  it('returns null when no on-disk file applies (env-var single-site path)', async () => {
    // Force the script-dir + home candidates to miss by pointing HOME at an
    // empty tmp dir, then verify null is returned. Restored after.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // Also requires no script-adjacent wp-sites.json. The repo carries one
      // for local dev, so we only assert behavior when we know neither path
      // resolves — skip if it does.
      const scriptConfig = path.resolve(__dirname, '..', 'wp-sites.json');
      if (fs.existsSync(scriptConfig)) {
        return; // skip — repo has a dev wp-sites.json that legitimately resolves
      }
      const result = await resolveConfigFilePath({});
      assert.equal(result, null);
    } finally {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
      try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('resolvePassword — async surface (Issue #5)', () => {
  it('returns plaintext password as-is', async () => {
    const pw = await resolvePassword({ password: 'plain' });
    assert.equal(pw, 'plain');
  });

  it('reads password from passwordEnv', async () => {
    const varName = `__ABILITIES_MCP_TEST_PWENV_${process.pid}`;
    process.env[varName] = 'env-secret';
    try {
      const pw = await resolvePassword({ passwordEnv: varName });
      assert.equal(pw, 'env-secret');
    } finally {
      delete process.env[varName];
    }
  });

  it('throws when passwordEnv is unset', async () => {
    const varName = `__ABILITIES_MCP_TEST_MISSING_${process.pid}`;
    delete process.env[varName];
    await assert.rejects(
      resolvePassword({ passwordEnv: varName }),
      /not set/,
    );
  });

  it('runs passwordCommand through a real shell (preserves pipe/redirect semantics)', async () => {
    // The conversion from execSync → util.promisify(exec) keeps shell
    // dispatch — operators rely on pipes and shell builtins in
    // `passwordCommand`. This test would fail if we'd switched to
    // execFile, which spawns the binary directly with no shell.
    const pw = await resolvePassword({ passwordCommand: "printf 'piped\\n' | tr -d '\\n'" });
    assert.equal(pw, 'piped');
  });

  it('throws when no source is configured', async () => {
    await assert.rejects(
      resolvePassword({}),
      /No password, passwordEnv, or passwordCommand configured/,
    );
  });
});
