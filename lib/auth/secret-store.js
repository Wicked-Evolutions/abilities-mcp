'use strict';

/**
 * SecretStore — interface for persisting tokens, refresh tokens, App Passwords,
 * and (future, see Appendix H.3.2) bridge identity material.
 *
 * The interface is a JSDoc typedef — there is no abstract base class. Any
 * object implementing the four methods below counts as a SecretStore.
 *
 * @typedef {object} SecretStore
 * @property {(service: string, account: string) => Promise<string|null>} get
 * @property {(service: string, account: string, secret: string) => Promise<void>} set
 * @property {(service: string, account: string) => Promise<boolean>} delete
 * @property {(service: string) => Promise<Array<{account: string, password: string}>>} findAll
 *
 * Service / account naming convention:
 *   service = 'abilities-mcp'
 *   account = '<siteId>/<kind>' where kind is 'access' | 'refresh' | 'apppassword' | 'apppassword-legacy' | 'client_id'
 *
 * Keychain references in wp-sites.json take the form:
 *   keychain://<service>/<account>
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const KEYCHAIN_REF_SCHEME = 'keychain://';

/**
 * Build a `keychain://service/account` reference for storage in wp-sites.json.
 * @param {string} service
 * @param {string} account
 * @returns {string}
 */
function makeRef(service, account) {
  if (!service || !account) {
    throw new Error('makeRef requires both service and account');
  }
  return `${KEYCHAIN_REF_SCHEME}${service}/${account}`;
}

/**
 * Parse a keychain reference back into service + account.
 * @param {string} ref
 * @returns {{service: string, account: string}}
 */
function parseRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(KEYCHAIN_REF_SCHEME)) {
    throw new Error(`Not a keychain reference: ${ref}`);
  }
  const remainder = ref.slice(KEYCHAIN_REF_SCHEME.length);
  const slashIdx = remainder.indexOf('/');
  if (slashIdx <= 0) {
    throw new Error(`Malformed keychain reference (expected service/account): ${ref}`);
  }
  return {
    service: remainder.slice(0, slashIdx),
    account: remainder.slice(slashIdx + 1),
  };
}

/**
 * Resolve a keychain reference through a SecretStore. Returns the secret value
 * or throws if not found.
 * @param {SecretStore} store
 * @param {string} ref
 * @returns {Promise<string>}
 */
async function resolveRef(store, ref) {
  const { service, account } = parseRef(ref);
  const value = await store.get(service, account);
  if (value === null || value === undefined) {
    throw new Error(`Keychain reference not found: ${ref}`);
  }
  return value;
}

module.exports = { KEYCHAIN_REF_SCHEME, makeRef, parseRef, resolveRef };
