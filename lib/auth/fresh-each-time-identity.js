'use strict';

/**
 * FreshEachTimeIdentityProvider — v1.0 BridgeIdentityProvider.
 *
 * Per Appendix H.3.2 (binding amendment to F.4):
 *
 *   - getClientId() always returns null → triggers a fresh DCR on every
 *     add-site / reauth call.
 *   - persistClientId() is intentionally a NO-OP. It does NOT write the
 *     client_id to the keychain. v1.1 (Option C) will switch this on, but
 *     turning it on safely requires:
 *       * a `keychain_schema_version: 2` companion key
 *       * defensive clearClientId() before DCR in add-site
 *       * orphan-client-id detection UX
 *     None of which exist in v1.0.
 *   - clearClientId() is also a NO-OP at the keychain layer (there is
 *     nothing persisted to clear). It accepts the call so callers can be
 *     written symmetrically against the future v1.1 implementation.
 *   - exportIdentity() returns null.
 *   - importIdentity() throws.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

class FreshEachTimeIdentityProvider {
  /**
   * @param {object} [opts]
   * @param {import('./secret-store').SecretStore} [opts.store]
   *   Held for symmetry with v1.1+ implementations. v1.0 does not use it.
   */
  constructor(opts = {}) {
    this._store = opts.store || null;
  }

  /**
   * v1.0: always null. Force fresh DCR every flow.
   * @param {string} _siteId
   * @returns {Promise<string|null>}
   */
  async getClientId(_siteId) {
    // v1.0: intentionally never reads from storage.
    // Uncomment in v1.1 (Option C) — and ONLY after implementing the upgrade
    // contract documented in Appendix H.3.2.
    return null;
  }

  /**
   * v1.0: intentionally does nothing.
   *
   * Forward-compat note: v1.1 (Option C) WILL persist client_id to the
   * keychain. It is NOT safe to enable that here without also implementing:
   *   - keychain_schema_version key alongside client_id (v1.1+ only)
   *   - clearClientId() called automatically on add-site (defensive cleanup)
   *   - operator UX for orphaned-client-id detection
   *
   * See Appendix H.3.2 in DESIGN — OAuth 2.1 in the Adapter for the upgrade
   * contract. Do NOT uncomment a write here without reading that section
   * first.
   *
   * @param {string} _siteId
   * @param {string} _clientId
   * @returns {Promise<void>}
   */
  async persistClientId(_siteId, _clientId) {
    // NO-OP — see contract above.
  }

  /**
   * v1.0: NO-OP (nothing was persisted).
   * @param {string} _siteId
   * @returns {Promise<void>}
   */
  async clearClientId(_siteId) {
    // NO-OP — symmetry with v1.1+ contract.
  }

  /**
   * v1.0: not supported. Returns null per F.4.
   * @param {string} _siteId
   * @returns {Promise<null>}
   */
  async exportIdentity(_siteId) {
    return null;
  }

  /**
   * v1.0: not supported. Throws per F.4.
   * @param {string} _siteId
   * @param {object} _bundle
   * @returns {Promise<never>}
   */
  async importIdentity(_siteId, _bundle) {
    const err = new Error('Identity import not supported in v1.0. Upgrade to v1.1+.');
    err.code = 'not_implemented';
    throw err;
  }
}

module.exports = { FreshEachTimeIdentityProvider };
