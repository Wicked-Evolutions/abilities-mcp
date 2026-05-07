'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { KeychainSecretStore: _KeychainSecretStore } = require('../../lib/auth/keychain-secret-store');

// All constructor calls in this file simulate a darwin host. Default the
// `/usr/bin/security` existence probe (#61) to true so the security-CLI
// dispatch tests run on linux / win32 CI hosts where the real path doesn't
// exist. Tests that exercise the probe failure path live in
// `keychain-secret-store-darwin-default.test.js` and inject explicitly.
function KeychainSecretStore(opts = {}) {
  return new _KeychainSecretStore({ fsExistsSync: () => true, ...opts });
}

/**
 * Issues #39 + #61 — darwin security-CLI behavior.
 *
 * #39 introduced a darwin-only security-CLI shell-out for the case where
 * macOS's hardened-runtime rejected bundled keytar.node inside Claude Desktop.
 * #61 promoted that path to the default on darwin (alpha-gate fix for the
 * multi-client ACL identity split). On darwin under the default `auto`
 * backend, the store engages `/usr/bin/security` directly without attempting
 * keytar at all.
 *
 * The new-default-on-darwin pin lives in
 * `keychain-secret-store-darwin-default.test.js`; this file covers the
 * shared security-CLI dispatch behavior plus the explicit-backend opt-outs.
 *
 *  - Keytar-success path is preserved on every platform (existing tests in
 *    `secret-store.test.js` cover the basic round-trip; this file covers
 *    security-CLI-specific dispatch).
 *  - On darwin under default `auto`, the store engages security-CLI mode and
 *    dispatches get/set/delete to a mocked `execFile`.
 *  - The "could not be found" stderr from `security` maps to keytar's
 *    null (get) / false (delete) return semantics.
 *  - Other stderr propagates as `SecretStoreError` with code
 *    `security_cli_failed`.
 *  - `isAvailable()` returns true in both keytar and security-CLI modes.
 *  - On linux/win32, a keytar load failure still throws `keytar_unavailable`
 *    (no security-CLI engagement — it's darwin-only).
 *  - `findAll` returns [] in security-CLI mode.
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

    // Issue #66: production code must call execFile with the absolute
    // /usr/bin/security path (no PATH resolution). Reject bare 'security'
    // here so a regression to bare-name resolves to "unexpected exec" and
    // every dispatch test fails loudly instead of silently passing.
    if (file !== '/usr/bin/security') {
      return cb(Object.assign(new Error(`unexpected exec file: ${file}`), {
        code: 1,
        stderr: `unexpected exec file: ${file}`,
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

describe('KeychainSecretStore — darwin security-CLI dispatch (#39 + #61)', () => {
  it('engages security-CLI mode on darwin under default auto backend', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      platform: 'darwin',
      exec: harness.exec,
    });
    assert.equal(await store.isAvailable(), true);
  });

  it('round-trips set/get/delete via security CLI on darwin', async () => {
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

  it('can force security-CLI on darwin even when keytar is available (Issue #58 backend alignment)', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      keytar: {
        async getPassword() { throw new Error('keytar must not be used'); },
        async setPassword() { throw new Error('keytar must not be used'); },
        async deletePassword() { throw new Error('keytar must not be used'); },
        async findCredentials() { throw new Error('keytar must not be used'); },
      },
      backend: 'security-cli',
      platform: 'darwin',
      exec: harness.exec,
    });

    await store.set('abilities-mcp', 'siteA/access', 'AT-FORCED');
    assert.equal(await store.get('abilities-mcp', 'siteA/access'), 'AT-FORCED');
    assert.ok(
      harness.calls.some((c) => c.args[0] === 'add-generic-password'),
      'forced backend must write through security CLI'
    );
    assert.ok(
      harness.calls.some((c) => c.args[0] === 'find-generic-password'),
      'forced backend must read through security CLI'
    );
  });

  it('reads ABILITIES_MCP_KEYCHAIN_BACKEND=security-cli from env on darwin', async () => {
    const harness = fakeSecurityExec();
    const store = new KeychainSecretStore({
      requireKeytar: () => {
        throw new Error('keytar must not be loaded when security-cli is forced');
      },
      env: { ABILITIES_MCP_KEYCHAIN_BACKEND: 'security-cli' },
      platform: 'darwin',
      exec: harness.exec,
    });

    await store.set('abilities-mcp', 'siteB/access', 'AT-ENV');
    assert.equal(await store.get('abilities-mcp', 'siteB/access'), 'AT-ENV');
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
      assert.equal(file, '/usr/bin/security');
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

  it('findAll returns [] in security-CLI mode (security CLI has no enumerate-by-service)', async () => {
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

  it('on darwin with explicit backend=keytar, security-CLI is NOT engaged (#61 opt-out)', async () => {
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
      backend: 'keytar',
      platform: 'darwin',
      exec: trapExec,
    });
    await store.set('abilities-mcp', 'siteA/access', 'AT');
    assert.equal(await store.get('abilities-mcp', 'siteA/access'), 'AT');
    const found = await store.findAll('abilities-mcp');
    assert.deepEqual(found, [{ account: 'sentinel', password: 'x' }]);
    assert.equal(execCalls, 0, 'security CLI must not be called when keytar is explicitly opted into');
  });

  it('backend=keytar disables the darwin security-CLI fallback', async () => {
    const store = new KeychainSecretStore({
      requireKeytar: REJECT_KEYTAR,
      backend: 'keytar',
      platform: 'darwin',
      exec: () => { throw new Error('security CLI must not be called'); },
    });
    assert.equal(await store.isAvailable(), false);
    await assert.rejects(
      store.get('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'keytar_unavailable'
    );
  });

  it('rejects unsupported keychain backend values with a typed error', async () => {
    const store = new KeychainSecretStore({
      backend: 'bogus',
      platform: 'darwin',
      exec: () => { throw new Error('exec must not be called'); },
    });
    assert.equal(await store.isAvailable(), false);
    await assert.rejects(
      store.get('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'invalid_keychain_backend'
        && /Unsupported ABILITIES_MCP_KEYCHAIN_BACKEND/.test(err.message)
    );
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

  it('backend=security-cli is rejected outside macOS', async () => {
    const store = new KeychainSecretStore({
      backend: 'security-cli',
      platform: 'linux',
      exec: () => { throw new Error('security CLI must not be called'); },
    });
    assert.equal(await store.isAvailable(), false);
    await assert.rejects(
      store.get('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'security_cli_unavailable'
        && /only supported on macOS/.test(err.message)
    );
  });
});
