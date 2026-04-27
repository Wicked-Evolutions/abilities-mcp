'use strict';

const os = require('node:os');

const {
  KeychainSecretStore,
  MemorySecretStore,
  FreshEachTimeIdentityProvider,
} = require('../auth');
const { resolveConfigPath } = require('./config-store');

/**
 * CliContext — DI container the subcommands use to reach the outside world.
 *
 * The router builds one CliContext per invocation and hands it to the chosen
 * command. Tests build their own context with `MemorySecretStore` and
 * dependency-injected helpers (clock, fetch, identity provider) so they never
 * touch real keychain or network.
 *
 * The context owns:
 *   - secretStore           SecretStore instance (KeychainSecretStore by default)
 *   - identityProvider      BridgeIdentityProvider (FreshEachTime in v1.0)
 *   - configPath            absolute path to wp-sites.json
 *   - debug                 boolean — when true, command errors include cause
 *   - softwareVersion       bridge version (read from package.json)
 *   - hostnameLabel         OS hostname, used in DCR client_name
 *   - userLabel             username, used in DCR client_name
 *   - now                   () => number (Date.now), test seam
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

function _readPackageVersion() {
  try {
    // eslint-disable-next-line global-require
    return require('../../package.json').version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Build a real context for production CLI invocations.
 *
 * @param {object} args                Parsed CLI args (minimum: { config?, debug? })
 * @returns {object} ctx
 */
function createContext(args = {}) {
  const { path: configPath } = resolveConfigPath(args);
  const secretStore = new KeychainSecretStore();
  const identityProvider = new FreshEachTimeIdentityProvider({ store: secretStore });
  return {
    secretStore,
    identityProvider,
    configPath,
    debug: !!args.debug,
    allowInsecure: !!args.allowInsecure,
    softwareVersion: _readPackageVersion(),
    hostnameLabel: _safeHostname(),
    userLabel: _safeUserLogin(),
    now: () => Date.now(),
  };
}

/**
 * Build a test context. Uses MemorySecretStore unless caller overrides.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function createTestContext(overrides = {}) {
  const secretStore = overrides.secretStore || new MemorySecretStore();
  const identityProvider = overrides.identityProvider
    || new FreshEachTimeIdentityProvider({ store: secretStore });
  return Object.assign({
    secretStore,
    identityProvider,
    configPath: overrides.configPath || null,
    debug: !!overrides.debug,
    allowInsecure: overrides.allowInsecure !== false,   // tests default to true
    softwareVersion: overrides.softwareVersion || '1.4.0-test',
    hostnameLabel: overrides.hostnameLabel || 'host.local',
    userLabel: overrides.userLabel || 'tester',
    now: overrides.now || (() => Date.now()),
  }, overrides);
}

function _safeHostname() {
  try { return os.hostname(); } catch { return 'host.local'; }
}

function _safeUserLogin() {
  try {
    const u = os.userInfo();
    return u.username || 'operator';
  } catch {
    return 'operator';
  }
}

module.exports = { createContext, createTestContext };
