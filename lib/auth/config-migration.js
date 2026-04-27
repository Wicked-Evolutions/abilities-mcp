'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { SCHEMA_VERSION } = require('./schema-v2');
const { AUTH_STATUS } = require('./events');
const { makeRef } = require('./secret-store');
const { MigrationError } = require('./errors');

/**
 * One-shot migration of wp-sites.json from the existing v1 (transport-style)
 * schema to v2 (oauth + apppassword per site, secrets in keychain).
 *
 * Per Appendix F.5 (binding):
 *   - Triggered on first bridge launch after upgrade.
 *   - One-shot, non-destructive: idempotent — calling again on a v2 file
 *     returns `{ migrated: false, alreadyV2: true }`.
 *   - Atomic write: temp file → rename.
 *   - Backup the original to `<file>.v1.bak`.
 *
 * The "v1" the spec describes assumes plaintext `auth.password`. The actual
 * existing bridge schema (lib/config.js) is transport-based with
 * `http.password` / `http.passwordEnv` / `http.passwordCommand` and a
 * separate `ssh` transport. This migration handles the real schema:
 *
 *   transport: http  + http.password           → method: apppassword, secret to keychain
 *   transport: http  + http.passwordEnv        → method: apppassword, env var resolved at migration time
 *   transport: http  + http.passwordCommand    → method: apppassword, command run at migration time
 *   transport: ssh                             → method: apppassword (carrier-only); ssh block preserved
 *                                                so existing SSH transport continues to work; OAuth
 *                                                add-site flow does not apply to SSH sites.
 *
 * SSH-only sites are tagged `auth.method = "apppassword"` with a synthetic
 * placeholder so v2 validation passes; the bridge's runtime still consults
 * the original `transport`, `ssh`, `http` blocks (preserved on each site)
 * for the actual connection. v2 adds OAuth fields but does NOT remove the
 * transport-level fields needed by existing transports.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const SECRET_SERVICE = 'abilities-mcp';

/**
 * Determine whether a parsed config is already at v2.
 * @param {object} config
 * @returns {boolean}
 */
function isV2(config) {
  return Boolean(config && config.schema_version === SCHEMA_VERSION);
}

/**
 * Resolve an http password from the legacy schema. Mirrors the resolver in
 * lib/config.js so migration sees the actual value to lift into keychain.
 *
 * @param {object} httpBlock
 * @param {object} env
 * @returns {string}
 */
function _resolveLegacyHttpPassword(httpBlock, env) {
  if (httpBlock.password) return httpBlock.password;
  if (httpBlock.passwordEnv) {
    const v = env[httpBlock.passwordEnv];
    if (typeof v !== 'string' || v.length === 0) {
      throw new MigrationError(
        `Cannot migrate site: passwordEnv "${httpBlock.passwordEnv}" is not set`,
        { code: 'env_var_missing' }
      );
    }
    return v;
  }
  if (httpBlock.passwordCommand) {
    try {
      return execSync(httpBlock.passwordCommand, { encoding: 'utf8' }).trim();
    } catch (err) {
      throw new MigrationError(
        `Cannot migrate site: passwordCommand failed: ${err.message}`,
        { code: 'password_command_failed', cause: err }
      );
    }
  }
  throw new MigrationError(
    `Cannot migrate site: no password, passwordEnv, or passwordCommand`,
    { code: 'no_password_source' }
  );
}

/**
 * Convert a single legacy site block to v2 shape. Stores any plaintext
 * secret to the SecretStore and replaces it with a keychain reference.
 *
 * @param {string} siteId
 * @param {object} legacy
 * @param {object} args
 * @param {object} args.secretStore
 * @param {object} [args.env]
 * @returns {Promise<{site: object, lifted: Array<{account:string}>}>}
 */
async function _convertSite(siteId, legacy, args) {
  const env = args.env || process.env;
  const lifted = [];
  // Carry forward fields the runtime still uses (transport, ssh, http,
  // multisite, label, url, allowInsecure, mcpServer).
  const v2 = {};
  for (const k of Object.keys(legacy)) {
    if (k === 'auth') continue;     // legacy didn't have one; preserve any existing
    v2[k] = legacy[k];
  }
  if (typeof v2.url !== 'string') {
    if (legacy.transport === 'ssh' && legacy.ssh && legacy.ssh.host) {
      v2.url = `ssh://${legacy.ssh.host}`;
    } else if (legacy.http && legacy.http.endpoint) {
      const u = new URL(legacy.http.endpoint);
      v2.url = u.origin;
    } else {
      v2.url = '';
    }
  }
  if (typeof v2.label !== 'string') v2.label = legacy.label || siteId;

  if (legacy.transport === 'http' && legacy.http) {
    const account = `${siteId}/apppassword`;
    const password = _resolveLegacyHttpPassword(legacy.http, env);
    await args.secretStore.set(SECRET_SERVICE, account, password);
    lifted.push({ account });
    v2.auth = {
      method: 'apppassword',
      username: legacy.http.username,
      password_ref: makeRef(SECRET_SERVICE, account),
    };
    // Sanitize the http block — drop password/passwordEnv/passwordCommand
    // so the keychain becomes the sole source of truth.
    if (v2.http) {
      v2.http = { ...v2.http };
      delete v2.http.password;
      delete v2.http.passwordEnv;
      delete v2.http.passwordCommand;
      v2.http.password_ref = makeRef(SECRET_SERVICE, account);
    }
  } else if (legacy.transport === 'ssh') {
    // SSH sites have no app-password to migrate. We still tag them
    // method: 'apppassword' so v2 validation passes; the synthetic
    // password_ref points at an empty entry callers can ignore.
    const account = `${siteId}/apppassword`;
    await args.secretStore.set(SECRET_SERVICE, account, '');
    lifted.push({ account });
    v2.auth = {
      method: 'apppassword',
      username: (legacy.ssh && legacy.ssh.user) || 'ssh',
      password_ref: makeRef(SECRET_SERVICE, account),
    };
  } else {
    // Already-shaped v2 sites pass through unchanged.
    if (legacy.auth && legacy.auth.method) {
      v2.auth = legacy.auth;
    } else {
      throw new MigrationError(
        `Cannot migrate site "${siteId}": no transport and no v2 auth block`,
        { code: 'unrecognized_site' }
      );
    }
  }

  v2.auth_status = legacy.auth_status || AUTH_STATUS.ACTIVE;
  return { site: v2, lifted };
}

/**
 * Migrate a parsed config object in memory. Side-effect: writes secrets to
 * the supplied secret store. Caller is responsible for the file I/O.
 *
 * @param {object} legacyConfig
 * @param {object} args
 * @param {object} args.secretStore
 * @param {object} [args.env]
 * @returns {Promise<{config: object, lifted: Array}>}
 */
async function migrateConfig(legacyConfig, args) {
  if (!args || !args.secretStore) {
    throw new MigrationError('migrateConfig requires secretStore', { code: 'no_store' });
  }
  if (!legacyConfig || typeof legacyConfig !== 'object') {
    throw new MigrationError('Legacy config is not an object', { code: 'invalid_input' });
  }
  if (!legacyConfig.sites || typeof legacyConfig.sites !== 'object') {
    throw new MigrationError('Legacy config has no sites', { code: 'invalid_input' });
  }

  const v2 = {
    $schema: 'https://wickedevolutions.com/schemas/abilities-mcp/wp-sites/v2.json',
    schema_version: SCHEMA_VERSION,
    sites: {},
  };
  if (legacyConfig.defaultSite) v2.defaultSite = legacyConfig.defaultSite;

  const allLifted = [];
  for (const [siteId, legacy] of Object.entries(legacyConfig.sites)) {
    const { site, lifted } = await _convertSite(siteId, legacy, args);
    v2.sites[siteId] = site;
    allLifted.push(...lifted.map((l) => ({ siteId, ...l })));
  }
  return { config: v2, lifted: allLifted };
}

/**
 * Atomic write of `config` to `filePath`. Writes to a temp file in the same
 * directory and renames. Restrictive permissions (0600) on the new file.
 * @param {string} filePath
 * @param {object} config
 */
async function _atomicWrite(filePath, config) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.wp-sites.json.tmp.${process.pid}.${Date.now()}`);
  const payload = JSON.stringify(config, null, 2) + '\n';
  await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
  // On POSIX, fs.rename is atomic if source and destination are on the same
  // filesystem (we ensured that by writing tmp into the same dir).
  await fs.promises.rename(tmp, filePath);
}

/**
 * One-shot migration of the on-disk wp-sites.json file. Idempotent.
 *
 * @param {object} args
 * @param {string} args.filePath
 * @param {object} args.secretStore
 * @param {object} [args.env]
 * @param {boolean} [args.dryRun]            Skip the write and the .v1.bak
 * @returns {Promise<{
 *   migrated: boolean,
 *   alreadyV2?: boolean,
 *   filePath: string,
 *   backupPath?: string,
 *   liftedCount?: number,
 * }>}
 */
async function migrateFile(args) {
  if (!args || !args.filePath) {
    throw new MigrationError('migrateFile requires filePath', { code: 'no_path' });
  }
  if (!args.secretStore) {
    throw new MigrationError('migrateFile requires secretStore', { code: 'no_store' });
  }

  let raw;
  try {
    raw = await fs.promises.readFile(args.filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Nothing to migrate — caller is starting clean.
      return { migrated: false, alreadyV2: false, filePath: args.filePath, missing: true };
    }
    throw new MigrationError(`Cannot read ${args.filePath}: ${err.message}`, {
      code: 'read_failed', cause: err,
    });
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new MigrationError(`Cannot parse ${args.filePath}: ${err.message}`, {
      code: 'parse_failed', cause: err,
    });
  }

  if (isV2(parsed)) {
    return { migrated: false, alreadyV2: true, filePath: args.filePath };
  }

  const { config: v2Config, lifted } = await migrateConfig(parsed, {
    secretStore: args.secretStore,
    env: args.env,
  });

  if (args.dryRun) {
    return {
      migrated: false,
      alreadyV2: false,
      filePath: args.filePath,
      previewConfig: v2Config,
      liftedCount: lifted.length,
    };
  }

  // Backup BEFORE writing — if backup fails, we have not yet damaged anything.
  const backupPath = `${args.filePath}.v1.bak`;
  try {
    await fs.promises.copyFile(args.filePath, backupPath);
  } catch (err) {
    throw new MigrationError(
      `Failed to back up ${args.filePath} → ${backupPath}: ${err.message}`,
      { code: 'backup_failed', cause: err }
    );
  }

  try {
    await _atomicWrite(args.filePath, v2Config);
  } catch (err) {
    throw new MigrationError(
      `Failed to write v2 config to ${args.filePath}: ${err.message}`,
      { code: 'write_failed', cause: err }
    );
  }

  return {
    migrated: true,
    filePath: args.filePath,
    backupPath,
    liftedCount: lifted.length,
  };
}

module.exports = {
  isV2,
  migrateConfig,
  migrateFile,
  _atomicWrite,
};
