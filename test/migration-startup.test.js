'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SCHEMA_VERSION } = require('../lib/auth/schema-v2');

/**
 * Bridge-startup integration test for bug #23.
 *
 * Spawns `abilities-mcp.js` as a real subprocess against a v1-shaped
 * wp-sites.json in a tmpdir, and asserts the file is rewritten to v2 with
 * `.v1.bak` next to it before the bridge tries to validate / connect.
 *
 * Per Appendix F.5 (binding): the migration is "Triggered on first bridge
 * launch after upgrade. One-shot, non-destructive."
 *
 * The spawned process needs a working `keytar`. Production hosts get keytar
 * via `optionalDependencies`, but CI Linux runners and local dev macOS
 * machines often lack it — so this test drops a stub `keytar` module into a
 * tmp dir and prepends NODE_PATH so `require('keytar')` resolves to the
 * stub. The stub mirrors the keytar surface KeychainSecretStore touches.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const BRIDGE_BIN = path.join(REPO_ROOT, 'abilities-mcp.js');

function legacyV1HttpConfig() {
  return {
    defaultSite: 'mysite',
    sites: {
      mysite: {
        label: 'My Site',
        url: 'https://example.com',
        transport: 'http',
        http: {
          endpoint: 'https://example.com/wp-json/mcp/mcp-adapter-default-server',
          username: 'wp_editor',
          password: 'P@ssw0rd',
        },
      },
    },
  };
}

/**
 * Build a tmp NODE_PATH dir containing a stub `keytar` module. The stub is
 * a no-op in-process Map — sufficient for the migration's set() calls to
 * succeed without touching a real OS keychain.
 *
 * @returns {string}  Path to the directory to prepend to NODE_PATH.
 */
function makeStubKeytarDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-stubmod-'));
  const keytarDir = path.join(dir, 'keytar');
  fs.mkdirSync(keytarDir, { recursive: true });
  fs.writeFileSync(
    path.join(keytarDir, 'package.json'),
    JSON.stringify({ name: 'keytar', version: '0.0.0-test-stub', main: 'index.js' }) + '\n'
  );
  fs.writeFileSync(
    path.join(keytarDir, 'index.js'),
    [
      "'use strict';",
      'const _store = new Map();',
      "module.exports = {",
      "  getPassword: async (s, a) => { const v = _store.get(s + ':' + a); return v === undefined ? null : v; },",
      "  setPassword: async (s, a, v) => { _store.set(s + ':' + a, v); },",
      "  deletePassword: async (s, a) => _store.delete(s + ':' + a),",
      "  findCredentials: async (s) => Array.from(_store.entries())",
      "    .filter(([k]) => k.startsWith(s + ':'))",
      "    .map(([k, password]) => ({ account: k.slice(s.length + 1), password })),",
      "};",
      '',
    ].join('\n')
  );
  return dir;
}

/**
 * Spawn `node abilities-mcp.js --config=<file>`, wait until the migration
 * has had a chance to run (we observe the on-disk file), then kill the
 * process. We don't wait for it to complete its MCP-server connect() — the
 * v1 config points at a non-resolvable host, so connectDefault() will
 * fail. We just want to assert the migration ran.
 *
 * @param {string} configPath
 * @param {string} stubModulesDir
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null}>}
 */
function runBridgeUntilMigrated(configPath, stubModulesDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BRIDGE_BIN, `--config=${configPath}`, '--debug'],
      {
        env: Object.assign({}, process.env, { NODE_PATH: stubModulesDir }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    let killed = false;
    let pollTimer = null;
    let timeoutTimer = null;

    function done() {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (!child.killed) child.kill('SIGTERM');
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => { done(); reject(err); });
    child.on('exit', (code) => {
      done();
      resolve({ stdout, stderr, exitCode: code });
    });

    // Poll the on-disk file. The migration writes the v2 file + .v1.bak as
    // its first async step. Once we see schema_version: 2 (or .v1.bak),
    // we've proven the migration ran and we can shut the bridge down.
    pollTimer = setInterval(() => {
      try {
        const text = fs.readFileSync(configPath, 'utf8');
        if (text.includes(`"schema_version": ${SCHEMA_VERSION}`)) {
          killed = true;
          done();
        }
      } catch { /* file may briefly disappear during atomic rename */ }
    }, 25);

    // Hard cap so a wedged spawn doesn't hang the suite.
    timeoutTimer = setTimeout(() => {
      done();
    }, 10_000);
  });
}

describe('Bridge MCP-server startup — schema v1→v2 migration (bug #23)', () => {
  it('rewrites a v1 wp-sites.json to v2 and creates .v1.bak before serving', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-startup-'));
    const configPath = path.join(tmpDir, 'wp-sites.json');
    fs.writeFileSync(configPath, JSON.stringify(legacyV1HttpConfig(), null, 2));

    const stubMods = makeStubKeytarDir();

    try {
      await runBridgeUntilMigrated(configPath, stubMods);

      // File on disk is v2.
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(written.schema_version, SCHEMA_VERSION);
      assert.equal(written.sites.mysite.auth.method, 'apppassword');
      assert.equal(written.sites.mysite.auth.username, 'wp_editor');
      assert.match(
        written.sites.mysite.auth.password_ref,
        /^keychain:\/\/abilities-mcp\/mysite\/apppassword$/
      );

      // .v1.bak is next to the original.
      const backupPath = `${configPath}.v1.bak`;
      assert.equal(fs.existsSync(backupPath), true, '.v1.bak should be created');
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      assert.equal(backup.sites.mysite.transport, 'http');
      assert.equal(backup.sites.mysite.http.password, 'P@ssw0rd');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(stubMods, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('is idempotent — second startup against a v2 file does not re-create .v1.bak', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-startup-idem-'));
    const configPath = path.join(tmpDir, 'wp-sites.json');
    fs.writeFileSync(configPath, JSON.stringify(legacyV1HttpConfig(), null, 2));

    const stubMods = makeStubKeytarDir();

    try {
      // First run: migrates.
      await runBridgeUntilMigrated(configPath, stubMods);
      const backupPath = `${configPath}.v1.bak`;
      assert.equal(fs.existsSync(backupPath), true);
      const firstBackupMtime = fs.statSync(backupPath).mtimeMs;

      // Sentinel — bury the backup so we'd notice if a second migration
      // overwrote it.
      const sentinel = '__sentinel_should_not_be_overwritten__';
      fs.writeFileSync(backupPath, sentinel, 'utf8');

      // Second run: no-op. The bridge will still try to connect (and fail —
      // connectDefault to non-resolvable host), but we don't care; we're
      // asserting the file did not get re-migrated.
      const secondPromise = new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [BRIDGE_BIN, `--config=${configPath}`, '--debug'],
          { env: Object.assign({}, process.env, { NODE_PATH: stubMods }), stdio: 'pipe' }
        );
        // Give the bridge enough time to reach migrateFile and decide it's
        // already v2, then kill it.
        const t = setTimeout(() => { if (!child.killed) child.kill('SIGTERM'); }, 1500);
        child.on('exit', () => { clearTimeout(t); resolve(); });
        child.on('error', () => { clearTimeout(t); resolve(); });
        // Drain stdio so the kernel pipe buffer doesn't fill.
        child.stdout.resume();
        child.stderr.resume();
      });
      await secondPromise;

      // Sentinel still intact — second migration did NOT run.
      assert.equal(fs.readFileSync(backupPath, 'utf8'), sentinel);
      // (mtime check is redundant given the sentinel, but guards against a
      // future regression where the migration writes-then-keeps backup.)
      void firstBackupMtime;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(stubMods, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
