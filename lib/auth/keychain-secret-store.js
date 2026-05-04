'use strict';

const { execFile } = require('node:child_process');

const { SecretStoreError } = require('./errors');

/**
 * KeychainSecretStore — keytar-backed SecretStore with a darwin-only
 * `security` CLI fallback for Claude Desktop's hardened-runtime barrier.
 *
 * keytar wraps macOS Keychain, Windows Credential Manager, and Linux libsecret
 * via a native binding (`build/Release/keytar.node`). It is declared as an
 * `optionalDependency` so a failed native build does not break `npm install`
 * for env-var-only operators.
 *
 * **The darwin fallback (issue #39).** When the bundled keytar binary fails
 * to dlopen inside Claude Desktop's hardened-runtime process — the macOS
 * code-signing rejects native binaries with mismatched Team IDs, Anthropic-
 * signed Claude Desktop refuses to load npm-distribution-signed keytar.node —
 * we fall back to shelling out to the macOS `security` CLI via
 * `child_process.execFile`. `security` is always installed on macOS, doesn't
 * require dynamic native loading, operates against the same macOS Keychain,
 * and runs as a child process out from under Claude Desktop's hardened-
 * runtime restrictions. The fallback fires only on darwin; on linux/win32 a
 * keytar load failure still throws `keytar_unavailable` (current behavior).
 *
 * Outside the .mcpb path — system Node, CLI install, npx, source clone —
 * keytar loads normally and the fallback never engages.
 *
 * If keytar is unavailable at runtime AND the darwin fallback also can't run,
 * every method throws `SecretStoreError` with code `keytar_unavailable` —
 * callers can detect that and fall back to a different store (e.g.
 * MemorySecretStore for tests, or surface to the user).
 *
 * Implements the SecretStore interface defined in `secret-store.js`.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

class KeychainSecretStore {
  /**
   * @param {object} [opts]
   * @param {object} [opts.keytar]         Inject a keytar module — primarily for tests.
   *                                       When omitted, keytar is required lazily on
   *                                       first use.
   * @param {Function} [opts.requireKeytar] Override the require call used to load
   *                                       keytar. Test seam: pass a function that
   *                                       throws to simulate the .mcpb-path dlopen
   *                                       rejection without breaking the real
   *                                       require('keytar') in the test runtime.
   * @param {string} [opts.platform]       Override `process.platform` for the
   *                                       fallback-eligibility decision. Test seam.
   * @param {Function} [opts.exec]         Override `child_process.execFile`. Test
   *                                       seam for the security-CLI fallback path.
   */
  constructor(opts = {}) {
    this._injected = opts.keytar || null;
    this._keytar = null;
    this._loadAttempted = false;
    this._loadError = null;
    this._fallbackMode = null; // null | 'security-cli'

    this._requireKeytar = opts.requireKeytar || ((id) => require(id));
    this._platform = opts.platform || process.platform;
    this._exec = opts.exec || execFile;
  }

  /**
   * Lazy load. Sets one of three terminal states:
   *  - `this._keytar` populated (keytar loaded normally; primary path)
   *  - `this._fallbackMode === 'security-cli'` (darwin fallback engaged)
   *  - `this._loadError` set + throws (non-darwin keytar failure)
   */
  _load() {
    if (this._keytar || this._fallbackMode) {
      return;
    }
    if (this._loadAttempted) {
      // Previously failed and we cached the error.
      throw new SecretStoreError(
        `OS keychain unavailable: ${this._loadError.message}`,
        { code: 'keytar_unavailable', cause: this._loadError }
      );
    }
    this._loadAttempted = true;

    if (this._injected) {
      this._keytar = this._injected;
      return;
    }

    try {
      this._keytar = this._requireKeytar('keytar');
      return;
    } catch (err) {
      // darwin: Claude Desktop's hardened-runtime rejects bundled keytar.node
      // with a Team ID mismatch (issue #39). Fall back to the `security` CLI
      // rather than throwing — the bridge keeps working against the same
      // macOS Keychain, just via shell-out.
      if (this._platform === 'darwin') {
        this._fallbackMode = 'security-cli';
        return;
      }
      this._loadError = err;
      throw new SecretStoreError(
        `OS keychain unavailable: ${err.message}`,
        { code: 'keytar_unavailable', cause: err }
      );
    }
  }

  /**
   * @returns {Promise<boolean>} true if keytar can be loaded on this host OR
   *                             the darwin security-CLI fallback is engaged.
   */
  async isAvailable() {
    try {
      this._load();
      return true;
    } catch {
      return false;
    }
  }

  async get(service, account) {
    this._load();
    if (this._fallbackMode === 'security-cli') {
      return this._securityGet(service, account);
    }
    return this._keytar.getPassword(service, account);
  }

  async set(service, account, secret) {
    if (typeof secret !== 'string') {
      throw new TypeError('SecretStore.set: secret must be a string');
    }
    this._load();
    if (this._fallbackMode === 'security-cli') {
      return this._securitySet(service, account, secret);
    }
    await this._keytar.setPassword(service, account, secret);
  }

  async delete(service, account) {
    this._load();
    if (this._fallbackMode === 'security-cli') {
      return this._securityDelete(service, account);
    }
    return this._keytar.deletePassword(service, account);
  }

  async findAll(service) {
    this._load();
    if (this._fallbackMode === 'security-cli') {
      // The macOS `security` CLI has no clean enumerate-by-service mode.
      // Returning [] here is safe because the bridge runtime path never
      // calls findAll — only the CLI subcommand `list-sites` does, and that
      // runs in system Node where keytar loads normally and this branch
      // is never taken. Documented in the issue body's "findAll" note.
      return [];
    }
    return this._keytar.findCredentials(service);
  }

  // ---------------------------------------------------------------------
  // darwin `security` CLI fallback — internal helpers.
  // ---------------------------------------------------------------------

  /**
   * Run the `security` CLI with the given args. Returns { stdout, stderr }
   * on success, rejects with an error carrying `.stderr` / `.stdout` /
   * `.code` (exit code) on failure. Uses `execFile` (not `exec`) so args
   * are not shell-interpreted — the password / account / service strings
   * pass through verbatim, no shell injection surface.
   */
  _execSecurity(args) {
    return new Promise((resolve, reject) => {
      this._exec('security', args, {}, (err, stdout, stderr) => {
        const stdoutStr = typeof stdout === 'string'
          ? stdout
          : (stdout ? stdout.toString() : '');
        const stderrStr = typeof stderr === 'string'
          ? stderr
          : (stderr ? stderr.toString() : '');
        if (err) {
          // Real child_process.execFile populates err.stderr / err.stdout
          // and ALSO passes them as cb args. Preserve whichever the caller
          // already attached (some test doubles attach to the err object
          // and don't pass via cb args); fall back to the cb args otherwise.
          if (typeof err.stderr !== 'string') err.stderr = stderrStr;
          if (typeof err.stdout !== 'string') err.stdout = stdoutStr;
          return reject(err);
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr });
      });
    });
  }

  async _securityGet(service, account) {
    try {
      const { stdout } = await this._execSecurity([
        'find-generic-password', '-s', service, '-a', account, '-w',
      ]);
      // -w prints just the password to stdout, terminated by a newline.
      return stdout.replace(/\n$/, '');
    } catch (err) {
      if (_isNotFound(err)) return null;
      throw new SecretStoreError(
        `security find-generic-password failed: ${(err.stderr || err.message || '').trim()}`,
        { code: 'security_cli_failed', cause: err }
      );
    }
  }

  async _securitySet(service, account, secret) {
    // -U updates the existing entry if present, adds it otherwise.
    // Note: passing the password as the last argv element is the standard
    // pattern for non-interactive `security` use; the macOS `security` CLI
    // exposes no stdin-only password input mode for non-interactive callers.
    // This is the same trade-off keytar's own native binding makes — the
    // password lives in process memory until the syscall completes.
    try {
      await this._execSecurity([
        'add-generic-password', '-U', '-s', service, '-a', account, '-w', secret,
      ]);
    } catch (err) {
      throw new SecretStoreError(
        `security add-generic-password failed: ${(err.stderr || err.message || '').trim()}`,
        { code: 'security_cli_failed', cause: err }
      );
    }
  }

  async _securityDelete(service, account) {
    try {
      await this._execSecurity([
        'delete-generic-password', '-s', service, '-a', account,
      ]);
      return true;
    } catch (err) {
      if (_isNotFound(err)) return false;
      throw new SecretStoreError(
        `security delete-generic-password failed: ${(err.stderr || err.message || '').trim()}`,
        { code: 'security_cli_failed', cause: err }
      );
    }
  }
}

/**
 * Detect the macOS `security` CLI's "entry not found" condition. Stderr from
 * `find-generic-password` / `delete-generic-password` against a missing entry
 * looks like:
 *   security: SecKeychainSearchCopyNext: The specified item could not be
 *   found in the keychain.
 * Match on the substring "could not be found" (case-insensitive) to map it
 * to keytar's null/false return semantics.
 */
function _isNotFound(err) {
  const stderr = (err && err.stderr) || '';
  return /could not be found/i.test(stderr);
}

module.exports = { KeychainSecretStore };
