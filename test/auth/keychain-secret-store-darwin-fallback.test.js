'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { KeychainSecretStore } = require('../../lib/auth/keychain-secret-store');

/**
 * Issue #39 — darwin security-CLI fallback.
 *
 * macOS's hardened-runtime rejects bundled keytar.node inside Claude Desktop
 * with a Team ID mismatch. The store detects this at `_load()` time and falls
 * back to the macOS `security` CLI via `child_process.execFile`. Tests cover:
 *
 *  - Keytar-success path is preserved on every platform (existing tests in
 *    `secret-store.test.js` cover the basic round-trip; this file adds
 *    fallback-specific coverage).
 *  - On darwin, when `require('keytar')` throws (simulated via the
 *    `requireKeytar` injection seam), the store enters fallback mode and
 *    dispatches get/set/delete to a mocked `execFile`.
 *  - The "could not be found" stderr from `security` maps to keytar's
 *    null (get) / false (delete) return semantics.
 *  - Other stderr propagates as `SecretStoreError` with code
 *    `security_cli_failed`.
 *  - `isAvailable()` returns true in both keytar and fallback modes.
 *  - On linux/win32, a keytar load failure still throws `keytar_unavailable`
 *    (no fallback engaged — the security CLI is darwin-only).
 *  - `findAll` returns [] in fallback mode.
 */

/**
 * Build a fake `child_process.execFile`-shaped function backed by an
 * in-memory keychain. Captures all calls for assertion.
 */
function fakeSecurityExec(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];

  function exec(file, args, opts, cb) {
    calls.push({ file, args: args.slice(), opts });

    if (file !== 'security') {
      return cb(Object.assign(new Error('unexpected exec'), {
        code: 1,
        stderr: 'unexpected exec',
      }));
    }

    const sub = args[0];
    const sIdx = args.indexOf('-s');
    const aIdx = args.indexOf('-a');
    const wIdx = args.indexOf('-w');
    const service = sIdx >= 0 ? args[sIdx + 1] : null;
    const account = aIdx >= 0 ? args[aIdx + 1] : null;
    const key = `${service}|${account}`;

    if (sub === 'find-generic-password') {
      // -w with a value would be at wIdx+1; -w as the last arg means "print
      // password only, no surrounding metadata."
      if (!store.has(key)) {
        return cb(Object.assign(new Error('exit 44'), {
          code: 44,
          stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
          stdout: '',
        }));
      }
      return cb(null, `${store.get(key)}\n`, '');
    }

    if (sub === 'add-generic-password') {
      // -U updates if exists, adds otherwise. Password is wIdx+1.
      const password = wIdx >= 0 ? args[wIdx + 1] : '';
      store.set(key, password);
      return cb(null, '', '');
    }

    if (sub === 'delete-generic-password') {
      if (!store.has(key)) {
        return cb(Object.assign(new Error('exit 44'), {
          code: 44,
          stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
          stdout: '',
        }));
      }
      store.delete(key);
      return cb(null, '', '');
    }

    return cb(Object.assign(new Error(`unknown subcommand ${sub}`), {
      code: 1, stderr: `unknown subcommand ${sub}`,
    }));
  }

  return { exec, store, calls };
}

const REJECT_KEYTAR = () => {
  throw new Error("dlopen(keytar.node, 0x0001): code signature in mapping process and mapped file (non-platform) have different Team IDs");
};

describe('KeychainSecretStore — darwin security-CLI fallback (#39)', () => {
  it('falls back to security-CLI on darwin when keytar require fails', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: harness.exec,
    });
    assert.equal(await store.isAvailable(), true);
  });

  it('round-trips set/get/delete via security CLI in fallback mode', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: harness.exec,
    });

    await store.set('abilities-mcp', 'siteA/access', 'AT-12345');
    assert.equal(await store.get('abilities-mcp', 'siteA/access'), 'AT-12345');
    assert.equal(await store.delete('abilities-mcp', 'siteA/access'), true);
    assert.equal(await store.get('abilities-mcp', 'siteA/access'), null);
  });

  it('get returns null when the security CLI reports "could not be found"', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: harness.exec,
    });
    assert.equal(await store.get('abilities-mcp', 'missing/account'), null);
  });

  it('delete returns false when the security CLI reports "could not be found"', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: harness.exec,
    });
    assert.equal(await store.delete('abilities-mcp', 'missing/account'), false);
  });

  it('propagates unexpected security-CLI errors as SecretStoreError code=security_cli_failed', async () => {
    function brokenExec(file, args, opts, cb) {
      cb(Object.assign(new Error('exit 1'), {
        code: 1,
        stderr: 'security: some other failure happened\n',
        stdout: '',
      }));
    }
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: brokenExec,
    });
    await assert.rejects(
      store.get('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'security_cli_failed'
        && /security find-generic-password failed/.test(err.message)
    );
    await assert.rejects(
      store.set('abilities-mcp', 'siteA/access', 'pw'),
      (err) => err && err.code === 'security_cli_failed'
        && /security add-generic-password failed/.test(err.message)
    );
    await assert.rejects(
      store.delete('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'security_cli_failed'
        && /security delete-generic-password failed/.test(err.message)
    );
  });

  it('maps a stuck security CLI prompt to SecretStoreError code=security_cli_timeout', async () => {
    function timedOutExec(file, args, opts, cb) {
      assert.equal(file, 'security');
      assert.equal(args[0], 'find-generic-password');
      assert.equal(opts.timeout, 5);
      cb(Object.assign(new Error('operation timed out'), {
        code: 'ETIMEDOUT',
        killed: true,
        signal: 'SIGTERM',
        stderr: '',
        stdout: '',
      }));
    }
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: timedOutExec,
      securityTimeoutMs: 5,
    });
    await assert.rejects(
      store.get('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'security_cli_timeout'
        && /timed out after 5ms/.test(err.message)
    );
  });

  it('findAll returns [] in fallback mode (security CLI has no enumerate-by-service)', async () => {
    const harness = fakeSecurityExec({
      'abilities-mcp|siteA/access': 'AT',
      'abilities-mcp|siteA/refresh': 'RT',
    });
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: harness.exec,
    });
    assert.deepEqual(await store.findAll('abilities-mcp'), []);
  });

  it('passes service/account/password through execFile args verbatim (no shell interpretation)', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: harness.exec,
    });
    // Password contains shell metachars that would explode under exec().
    const trickyPassword = 'p$wd "with" `dangerous` chars; rm -rf /';
    await store.set('abilities-mcp', 'siteX/apppassword', trickyPassword);
    assert.equal(await store.get('abilities-mcp', 'siteX/apppassword'), trickyPassword);

    // Verify the execFile call carried the password as a separate argv element,
    // not concatenated into a shell string.
    const setCall = harness.calls.find((c) => c.args[0] === 'add-generic-password');
    const wIdx = setCall.args.indexOf('-w');
    assert.equal(setCall.args[wIdx + 1], trickyPassword);
  });

  it('on darwin, when keytar IS available, fallback is NOT engaged', async () => {
    function fakeKeytar() {
      const map = new Map();
      return {
        async getPassword(s, a) { return map.has(`${s}|${a}`) ? map.get(`${s}|${a}`) : null; },
        async setPassword(s, a, v) { map.set(`${s}|${a}`, v); },
        async deletePassword(s, a) { return map.delete(`${s}|${a}`); },
        async findCredentials() { return [{ account: 'sentinel', password: 'x' }]; },
      };
    }
    let execCalls = 0;
    const trapExec = () => { execCalls += 1; };
    const store = new KeychainSecretStore({
      keytar: fakeKeytar(),
      platform: 'darwin',
      exec: trapExec,
    });
    await store.set('abilities-mcp', 'siteA/access', 'AT');
    assert.equal(await store.get('abilities-mcp', 'siteA/access'), 'AT');
    const found = await store.findAll('abilities-mcp');
    assert.deepEqual(found, [{ account: 'sentinel', password: 'x' }]);
    assert.equal(execCalls, 0, 'security CLI must not be called when keytar loads normally');
  });
});

describe('KeychainSecretStore — non-darwin keytar failure still throws (#39)', () => {
  for (const platform of ['linux', 'win32']) {
    it(`on ${platform}, keytar load failure throws keytar_unavailable (no fallback)`, async () => {
      const store = new KeychainSecretStore({
        requireKeytar: REJECT_KEYTAR,
        platform,
        exec: () => { throw new Error('exec must not be called'); },
      });
      assert.equal(await store.isAvailable(), false);
      await assert.rejects(
        store.get('abilities-mcp', 'siteA/access'),
        (err) => err && err.code === 'keytar_unavailable'
      );
      await assert.rejects(
        store.set('abilities-mcp', 'siteA/access', 'pw'),
        (err) => err && err.code === 'keytar_unavailable'
      );
      await assert.rejects(
        store.delete('abilities-mcp', 'siteA/access'),
        (err) => err && err.code === 'keytar_unavailable'
      );
    });
  }
});
