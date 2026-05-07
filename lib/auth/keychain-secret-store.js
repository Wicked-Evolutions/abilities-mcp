'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');

const { SecretStoreError } = require('./errors');

const DEFAULT_SECURITY_TIMEOUT_MS = 30_000;
const DEFAULT_KEYCHAIN_BACKEND = 'auto';
const KEYCHAIN_BACKENDS = new Set(['auto', 'keytar', 'security-cli']);
const SECURITY_CLI_PATH = '/usr/bin/security';

/**
 * KeychainSecretStore — keytar-backed SecretStore with a darwin-only
 * `security` CLI fallback for Claude Desktop's hardened-runtime barrier.
 *
 * keytar wraps macOS Keychain, Windows Credential Manager, and Linux libsecret
 * via a native binding (`build/Release/keytar.node`). It is declared as an
 * `optionalDependency` so a failed native build does not break `npm install`
 * for env-var-only operators.
 *
 * **Darwin default: security-CLI (issue #61).** On darwin under the default
 * `auto` backend, the store engages the `/usr/bin/security` CLI directly
 * without attempting to load keytar. This is the alpha-gate fix for the
 * multi-client macOS keychain ACL identity split: every runtime that spawns
 * the bridge — Claude Desktop's `.mcpb`, Claude Code via npm/node, Codex,
 * terminal CLI, etc. — issues `SecKeychainItem*` calls through the same
 * caller binary (`/usr/bin/security`), so macOS's per-binary ACL trusted-
 * application list contains exactly one entry. After the operator's first
 * "Always Allow" the entry is silently readable from every runtime.
 *
 * Issue #58's `ABILITIES_MCP_KEYCHAIN_BACKEND=security-cli` env var was the
 * opt-in shape of this fix; #61 promotes it to the default. Operators who
 * need keytar on darwin (uncommon — debugging, custom build) can opt back in
 * with `ABILITIES_MCP_KEYCHAIN_BACKEND=keytar`.
 *
 * **The original darwin fallback (issue #39).** When the bundled keytar
 * binary failed to dlopen inside Claude Desktop's hardened-runtime process,
 * the store fell back to `/usr/bin/security` automatically. With the #61
 * default in place, darwin auto never attempts keytar in the first place, so
 * the dlopen-rejection branch is no longer reachable from `auto`. The
 * security-CLI implementation itself is the same code path that's been
 * shipping inside the .mcpb runtime since v1.5.3.
 *
 * Linux / win32 behavior unchanged: keytar via libsecret / Credential
 * Manager. There is no `/usr/bin/security` equivalent and no analogous ACL
 * prompt, so the per-platform identity-split bug doesn't apply.
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
   * @param {number} [opts.securityTimeoutMs] Max time to wait for the darwin
   *                                       `security` CLI before surfacing a typed
   *                                       timeout error. Defaults to 30s.
   * @param {string} [opts.backend]        Secret backend: auto (default), keytar,
   *                                       or security-cli. When omitted, reads
   *                                       ABILITIES_MCP_KEYCHAIN_BACKEND.
   * @param {object} [opts.env]            Env object for backend selection tests.
   * @param {Function} [opts.fsExistsSync] Override `fs.existsSync` for the
   *                                       `/usr/bin/security` existence probe.
   *                                       Test seam.
   */
  constructor(opts = {}) {
    this._injected = opts.keytar || null;
    this._keytar = null;
    this._loadAttempted = false;
    this._loadError = null;
    this._loadErrorCode = 'keytar_unavailable';
    this._fallbackMode = null; // null | 'security-cli'

    this._requireKeytar = opts.requireKeytar || ((id) => require(id));
    this._platform = opts.platform || process.platform;
    this._exec = opts.exec || execFile;
    this._fsExistsSync = opts.fsExistsSync || existsSync;
    const env = opts.env || process.env;
    this._backend = _normalizeBackend(opts.backend || env.ABILITIES_MCP_KEYCHAIN_BACKEND);
    this._securityTimeoutMs = Number.isFinite(opts.securityTimeoutMs) && opts.securityTimeoutMs > 0
      ? opts.securityTimeoutMs
      : DEFAULT_SECURITY_TIMEOUT_MS;
  }

  /**
   * Lazy load. Sets one of three terminal states:
   *  - `this._fallbackMode === 'security-cli'` (darwin auto default + explicit
   *    security-cli backend)
   *  - `this._keytar` populated (keytar loaded normally; non-darwin auto, or
   *    explicit `backend: 'keytar'` anywhere)
   *  - `this._loadError` set + throws (security-cli engagement on a host
   *    without `/usr/bin/security`, keytar load failure when keytar is the
   *    selected backend, invalid backend value)
   */
  _load() {
    if (this._keytar || this._fallbackMode) {
      return;
    }
    if (this._loadAttempted) {
      // Previously failed and we cached the error.
      throw new SecretStoreError(
        `OS keychain unavailable: ${this._loadError.message}`,
        { code: this._loadErrorCode, cause: this._loadError }
      );
    }
    this._loadAttempted = true;

    if (!KEYCHAIN_BACKENDS.has(this._backend)) {
      const err = new Error(
        `Unsupported ABILITIES_MCP_KEYCHAIN_BACKEND="${this._backend}". ` +
        `Use one of: auto, keytar, security-cli.`
      );
      this._loadError = err;
      this._loadErrorCode = 'invalid_keychain_backend';
      throw new SecretStoreError(
        `OS keychain unavailable: ${err.message}`,
        { code: this._loadErrorCode, cause: err }
      );
    }

    if (this._backend === 'security-cli') {
      if (this._platform !== 'darwin') {
        const err = new Error(
          `ABILITIES_MCP_KEYCHAIN_BACKEND=security-cli is only supported on macOS.`
        );
        this._loadError = err;
        this._loadErrorCode = 'security_cli_unavailable';
        throw new SecretStoreError(
          `OS keychain unavailable: ${err.message}`,
          { code: this._loadErrorCode, cause: err }
        );
      }
      this._engageSecurityCliMode();
      return;
    }

    // Issue #61: darwin default = security-CLI for cross-runtime ACL identity.
    // All bridge spawn paths (Claude Desktop .mcpb, Claude Code, Codex,
    // terminal CLI) issue keychain syscalls through the same `/usr/bin/security`
    // caller binary, so macOS sees one ACL identity instead of N. Operators
    // who want keytar on darwin can opt back in with backend=keytar.
    if (this._backend === 'auto' && this._platform === 'darwin') {
      this._engageSecurityCliMode();
      return;
    }

    if (this._injected) {
      this._keytar = this._injected;
      return;
    }

    try {
      this._keytar = this._requireKeytar('keytar');
      return;
    } catch (err) {
      // backend === 'keytar' (any platform), or backend === 'auto' on
      // linux/win32. No fallback: the security-CLI is darwin-only, and the
      // darwin auto path above already engaged it before we got here.
      this._loadError = err;
      this._loadErrorCode = 'keytar_unavailable';
      throw new SecretStoreError(
        `OS keychain unavailable: ${err.message}`,
        { code: this._loadErrorCode, cause: err }
      );
    }
  }

  /**
   * Probe `/usr/bin/security` and engage security-CLI mode. Surfaces a typed
   * error early (at first `_load()`) on hosts where the binary is missing —
   * the corporate-locked-macOS edge case — instead of waiting for the first
   * keychain operation to fail at execFile spawn time.
   *
   * Sets `_fallbackMode = 'security-cli'` on success; throws
   * SecretStoreError code `security_cli_unavailable` on failure.
   */
  _engageSecurityCliMode() {
    if (!this._fsExistsSync(SECURITY_CLI_PATH)) {
      const err = new Error(
        `${SECURITY_CLI_PATH} not found. macOS Keychain access requires the ` +
        `security CLI (standard at ${SECURITY_CLI_PATH} on a normal macOS ` +
        `install). This may indicate a corporate-locked or non-standard host.`
      );
      this._loadError = err;
      this._loadErrorCode = 'security_cli_unavailable';
      throw new SecretStoreError(
        `OS keychain unavailable: ${err.message}`,
        { code: this._loadErrorCode, cause: err }
      );
    }
    this._fallbackMode = 'security-cli';
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

  // findAll() is unavailable on the Darwin security-cli backend; current
  // bridge flows do not rely on it. The macOS `security` CLI has no clean
  // enumerate-by-service mode, and with #61 making security-cli the darwin
  // default this method returns [] for every darwin caller. Linux/Windows
  // (keytar) continue to enumerate normally.
  async findAll(service) {
    this._load();
    if (this._fallbackMode === 'security-cli') {
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
      const opts = {
        timeout: this._securityTimeoutMs,
        killSignal: 'SIGTERM',
      };
      this._exec('security', args, opts, (err, stdout, stderr) => {
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
          if (_isTimeout(err) && typeof err.timeoutMs !== 'number') {
            err.timeoutMs = this._securityTimeoutMs;
          }
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
      if (_isTimeout(err)) {
        throw new SecretStoreError(
          `security find-generic-password timed out after ${err.timeoutMs || this._securityTimeoutMs}ms; a macOS Keychain prompt may be waiting for approval`,
          { code: 'security_cli_timeout', cause: err }
        );
      }
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
      if (_isTimeout(err)) {
        throw new SecretStoreError(
          `security add-generic-password timed out after ${err.timeoutMs || this._securityTimeoutMs}ms; a macOS Keychain prompt may be waiting for approval`,
          { code: 'security_cli_timeout', cause: err }
        );
      }
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
      if (_isTimeout(err)) {
        throw new SecretStoreError(
          `security delete-generic-password timed out after ${err.timeoutMs || this._securityTimeoutMs}ms; a macOS Keychain prompt may be waiting for approval`,
          { code: 'security_cli_timeout', cause: err }
        );
      }
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

function _isTimeout(err) {
  if (!err) return false;
  if (err.code === 'ETIMEDOUT') return true;
  if (err.killed && err.signal === 'SIGTERM') return true;
  return /timed out/i.test(err.message || '');
}

function _normalizeBackend(value) {
  if (!value) return DEFAULT_KEYCHAIN_BACKEND;
  return String(value).trim().toLowerCase();
}

module.exports = { KeychainSecretStore };
