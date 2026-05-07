'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { KeychainSecretStore } = require('../../lib/auth/keychain-secret-store');

/**
 * Issue #61 — darwin default = security-CLI for cross-runtime ACL identity.
 *
 * Pins the new alpha-gate behavior promoted from the v1.5.5 #58 opt-in:
 *
 *  - On darwin under the default `auto` backend, `_load()` engages
 *    `/usr/bin/security` directly without ever calling `requireKeytar`.
 *    This is the structural fix for the multi-client keychain ACL identity
 *    split — every runtime that spawns the bridge issues `SecKeychainItem*`
 *    calls through the same `/usr/bin/security` caller binary.
 *  - The `_engageSecurityCliMode()` probe surfaces a typed
 *    `SecretStoreError(code: 'security_cli_unavailable')` if `/usr/bin/security`
 *    is missing on the host (corporate-locked / non-standard macOS), so
 *    operators get a clear early diagnostic rather than an opaque execFile
 *    spawn failure on the first ability call.
 *
 * Shared security-CLI dispatch coverage (round-trip, error mapping, timeout,
 * etc.) lives in `keychain-secret-store-darwin-fallback.test.js`.
 */

function noopExec(file, args, opts, cb) {
  cb(null, '', '');
}

describe('KeychainSecretStore — darwin auto default = security-CLI (#61)', () => {
  // Tests in this describe simulate `platform: 'darwin'` while running on
  // Ubuntu CI. The new #61 probe synchronously checks `/usr/bin/security`
  // existence, which is absent on linux CI runners; injecting
  // `fsExistsSync: () => true` makes the probe succeed so the rest of the
  // dispatch behavior is what's actually being asserted. The probe-failure
  // path is exercised explicitly in the second describe block below.
  const PROBE_TRUE = () => true;

  it('does NOT invoke requireKeytar on darwin under default auto backend', async () => {
    let requireCalls = 0;
    const requireKeytar = () => {
      requireCalls += 1;
      throw new Error('requireKeytar must not be called under #61 darwin auto');
    };

    const store = new KeychainSecretStore({
      requireKeytar,
      platform: 'darwin',
      fsExistsSync: PROBE_TRUE,
      // exec stub never reached because we only call isAvailable().
      exec: noopExec,
    });

    assert.equal(await store.isAvailable(), true);
    assert.equal(requireCalls, 0, 'darwin + auto must engage security-CLI without trying keytar');
  });

  it('does NOT invoke requireKeytar even when keytar is injected on darwin auto', async () => {
    // Belt-and-braces: a stale callsite that still passes opts.keytar should
    // also not pull keytar into the load path on darwin auto. The injected
    // keytar is simply ignored in favor of the security-CLI default.
    let injectedTouched = 0;
    const fakeKeytar = {
      get getPassword() { injectedTouched += 1; return async () => null; },
      get setPassword() { injectedTouched += 1; return async () => undefined; },
      get deletePassword() { injectedTouched += 1; return async () => true; },
      get findCredentials() { injectedTouched += 1; return async () => []; },
    };

    const store = new KeychainSecretStore({
      keytar: fakeKeytar,
      platform: 'darwin',
      fsExistsSync: PROBE_TRUE,
      exec: noopExec,
    });

    assert.equal(await store.isAvailable(), true);
    assert.equal(injectedTouched, 0, 'injected keytar must not be touched under #61 darwin auto');
  });

  it('uses the security-CLI execFile path for set/get/delete under darwin auto default', async () => {
    const calls = [];
    function captureExec(file, args, opts, cb) {
      calls.push({ file, args: args.slice() });
      const sub = args[0];
      const wIdx = args.indexOf('-w');
      if (sub === 'add-generic-password') return cb(null, '', '');
      if (sub === 'find-generic-password') return cb(null, `${args[wIdx + 1] || 'pw-stub'}\n`, '');
      if (sub === 'delete-generic-password') return cb(null, '', '');
      return cb(Object.assign(new Error('unknown'), { stderr: 'unknown' }));
    }

    const store = new KeychainSecretStore({
      platform: 'darwin',
      fsExistsSync: PROBE_TRUE,
      exec: captureExec,
      // No requireKeytar override needed — auto darwin never calls it.
    });

    await store.set('abilities-mcp', 'siteA/access', 'AT-DEFAULT');
    await store.get('abilities-mcp', 'siteA/access');
    await store.delete('abilities-mcp', 'siteA/access');

    assert.equal(calls.length, 3, 'set/get/delete must each invoke security CLI');
    assert.equal(calls[0].file, 'security');
    assert.equal(calls[0].args[0], 'add-generic-password');
    assert.equal(calls[1].args[0], 'find-generic-password');
    assert.equal(calls[2].args[0], 'delete-generic-password');
  });
});

describe('KeychainSecretStore — /usr/bin/security existence probe (#61)', () => {
  it('surfaces security_cli_unavailable when /usr/bin/security is missing under darwin auto', async () => {
    const store = new KeychainSecretStore({
      platform: 'darwin',
      fsExistsSync: (p) => {
        assert.equal(p, '/usr/bin/security');
        return false;
      },
      exec: () => { throw new Error('exec must not be called when probe fails'); },
    });

    assert.equal(await store.isAvailable(), false);
    await assert.rejects(
      store.get('abilities-mcp', 'siteA/access'),
      (err) => err
        && err.code === 'security_cli_unavailable'
        && /\/usr\/bin\/security not found/.test(err.message)
        && /corporate-locked or non-standard host/.test(err.message),
    );
  });

  it('surfaces security_cli_unavailable when /usr/bin/security is missing under explicit backend=security-cli', async () => {
    const store = new KeychainSecretStore({
      backend: 'security-cli',
      platform: 'darwin',
      fsExistsSync: () => false,
      exec: () => { throw new Error('exec must not be called when probe fails'); },
    });

    assert.equal(await store.isAvailable(), false);
    await assert.rejects(
      store.set('abilities-mcp', 'siteA/access', 'pw'),
      (err) => err && err.code === 'security_cli_unavailable',
    );
  });

  it('passes the probe and engages security-CLI when /usr/bin/security exists', async () => {
    let probeCalls = 0;
    const store = new KeychainSecretStore({
      platform: 'darwin',
      fsExistsSync: (p) => {
        probeCalls += 1;
        assert.equal(p, '/usr/bin/security');
        return true;
      },
      exec: noopExec,
    });

    assert.equal(await store.isAvailable(), true);
    assert.equal(probeCalls, 1, 'probe runs exactly once at first _load()');

    // Second call should NOT re-probe — _load is memoized.
    assert.equal(await store.isAvailable(), true);
    assert.equal(probeCalls, 1, 'probe must not re-run on subsequent _load() calls');
  });

  it('caches the probe failure across subsequent calls (no repeated fs.existsSync)', async () => {
    let probeCalls = 0;
    const store = new KeychainSecretStore({
      platform: 'darwin',
      fsExistsSync: () => { probeCalls += 1; return false; },
      exec: noopExec,
    });

    await assert.rejects(store.get('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'security_cli_unavailable');
    await assert.rejects(store.set('abilities-mcp', 'siteA/access', 'pw'),
      (err) => err && err.code === 'security_cli_unavailable');
    await assert.rejects(store.delete('abilities-mcp', 'siteA/access'),
      (err) => err && err.code === 'security_cli_unavailable');

    assert.equal(probeCalls, 1, 'probe must not re-run after first cached failure');
  });
});
