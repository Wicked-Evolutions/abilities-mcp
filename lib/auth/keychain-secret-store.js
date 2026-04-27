'use strict';

const { SecretStoreError } = require('./errors');

/**
 * KeychainSecretStore — keytar-backed SecretStore.
 *
 * keytar wraps macOS Keychain, Windows Credential Manager, and Linux libsecret.
 * It is declared as an `optionalDependency` so a failed native build does not
 * break `npm install` for env-var-only operators. If keytar is unavailable at
 * runtime, every method on this store throws `SecretStoreError` with code
 * `keytar_unavailable` — callers can detect that and fall back to a different
 * store (e.g. MemorySecretStore for tests, or surface to the user).
 *
 * Implements the SecretStore interface defined in `secret-store.js`.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

class KeychainSecretStore {
  /**
   * @param {object} [opts]
   * @param {object} [opts.keytar]  Inject a keytar module — primarily for tests.
   *                                When omitted, keytar is required lazily on
   *                                first use.
   */
  constructor(opts = {}) {
    this._injected = opts.keytar || null;
    this._keytar = null;
    this._loadAttempted = false;
    this._loadError = null;
  }

  _load() {
    if (this._keytar) return this._keytar;
    if (this._loadAttempted) {
      if (this._loadError) {
        throw new SecretStoreError(
          `OS keychain unavailable: ${this._loadError.message}`,
          { code: 'keytar_unavailable', cause: this._loadError }
        );
      }
      return this._keytar;
    }
    this._loadAttempted = true;
    if (this._injected) {
      this._keytar = this._injected;
      return this._keytar;
    }
    try {
      // eslint-disable-next-line global-require
      this._keytar = require('keytar');
      return this._keytar;
    } catch (err) {
      this._loadError = err;
      throw new SecretStoreError(
        `OS keychain unavailable: ${err.message}`,
        { code: 'keytar_unavailable', cause: err }
      );
    }
  }

  /** @returns {Promise<boolean>} true if keytar can be loaded on this host. */
  async isAvailable() {
    try {
      this._load();
      return true;
    } catch {
      return false;
    }
  }

  async get(service, account) {
    const keytar = this._load();
    return keytar.getPassword(service, account);
  }

  async set(service, account, secret) {
    if (typeof secret !== 'string') {
      throw new TypeError('SecretStore.set: secret must be a string');
    }
    const keytar = this._load();
    await keytar.setPassword(service, account, secret);
  }

  async delete(service, account) {
    const keytar = this._load();
    return keytar.deletePassword(service, account);
  }

  async findAll(service) {
    const keytar = this._load();
    return keytar.findCredentials(service);
  }
}

module.exports = { KeychainSecretStore };
