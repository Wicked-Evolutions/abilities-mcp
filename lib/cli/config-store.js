'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { SCHEMA_VERSION, validate, emptyConfig } = require('../auth/schema-v2');
const { CredentialCoordinator } = require('../auth/credential-coordinator');
const { AUTH_STATUS } = require('../auth/events');
const { makeRef } = require('../auth/secret-store');
const { CliError, EXIT_CONFIG } = require('./errors');

const SECRET_SERVICE = 'abilities-mcp';
const CONFIG_COMMIT_RETRIES = 40;
const CONFIG_COMMIT_RETRY_MS = 15;

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _withConfigCommitRetry(coordinator, operation, callback, opts) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await coordinator.withConfigCommitLock(operation, callback, opts);
    } catch (err) {
      if (!err || err.code !== 'credential_operation_busy' || attempt >= CONFIG_COMMIT_RETRIES) {
        throw err;
      }
      await _sleep(CONFIG_COMMIT_RETRY_MS);
    }
  }
}

/**
 * Read / write the v2 wp-sites.json file from a CLI command.
 *
 * This is the only place CLI commands touch the on-disk config — keeping it
 * here means atomic-write, validation, and pathing rules live in one spot.
 *
 * Search order (matches lib/config.js so the MCP server and CLI agree on
 * which file is "the" config):
 *   1. --config=<path> explicit
 *   2. <repo root>/wp-sites.json (alongside the bridge bin)
 *   3. ~/.abilities-mcp/wp-sites.json
 *
 * If no file exists, `resolveConfigPath` returns the canonical home-dir path
 * so commands like `add-site` write a fresh config there.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const HOME_DIR_REL = path.join('.abilities-mcp', 'wp-sites.json');

function _scriptRootConfig() {
  // lib/cli/ → repo root
  return path.resolve(__dirname, '..', '..', 'wp-sites.json');
}

function _homeConfig() {
  return path.join(os.homedir(), HOME_DIR_REL);
}

/**
 * Resolve the on-disk wp-sites.json path. Returns the first match in the
 * search order, or the home-dir path if none exists yet.
 *
 * @param {object} [args]
 * @param {string} [args.config]
 * @returns {{ path: string, exists: boolean, source: 'explicit'|'script-root'|'home'|'home-default' }}
 */
function resolveConfigPath(args = {}) {
  if (args.config) {
    return {
      path: path.resolve(args.config),
      exists: fs.existsSync(args.config),
      source: 'explicit',
    };
  }
  const scriptCfg = _scriptRootConfig();
  if (fs.existsSync(scriptCfg)) {
    return { path: scriptCfg, exists: true, source: 'script-root' };
  }
  const homeCfg = _homeConfig();
  if (fs.existsSync(homeCfg)) {
    return { path: homeCfg, exists: true, source: 'home' };
  }
  return { path: homeCfg, exists: false, source: 'home-default' };
}

/**
 * Read a v2 config file. Throws CliError on parse / validation failure.
 *
 * @param {string} filePath
 * @returns {object}
 */
function readConfig(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CliError(`Config not found: ${filePath}`, {
        exitCode: EXIT_CONFIG,
        nextAction: 'Run: abilities-mcp add-site <url> to create your first site',
        cause: err,
      });
    }
    throw new CliError(`Cannot read ${filePath}: ${err.message}`, {
      exitCode: EXIT_CONFIG,
      nextAction: 'Verify file permissions on the config path',
      cause: err,
    });
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new CliError(`Cannot parse ${filePath}: ${err.message}`, {
      exitCode: EXIT_CONFIG,
      nextAction: 'Inspect the JSON syntax of the config file',
      cause: err,
    });
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new CliError(
      `Config schema is v${parsed.schema_version || '<unknown>'} but CLI expects v${SCHEMA_VERSION}`,
      {
        exitCode: EXIT_CONFIG,
        nextAction: 'Run the bridge once to trigger v1→v2 migration, or update the config manually',
      }
    );
  }
  const v = validate(parsed);
  if (!v.ok) {
    throw new CliError(
      `Config failed v2 validation:\n  - ${v.errors.join('\n  - ')}`,
      {
        exitCode: EXIT_CONFIG,
        nextAction: 'Fix the listed validation errors in the config file',
      }
    );
  }
  return parsed;
}

/**
 * Return a non-secret credential version for a site. Long-running CLI
 * operations use this as a generation/identity fence before publishing a
 * replacement credential pair. It intentionally includes the legacy refs:
 * a pre-pair site still has a stable credential identity derived from them.
 *
 * @param {object|null|undefined} site
 * @returns {object|null}
 */
function siteCredentialVersion(site) {
  if (!site || !site.auth) return null;
  const auth = site.auth;
  return {
    method: auth.method || null,
    identity: CredentialCoordinator.identityForAuth(auth),
    generation: auth.credential_generation || null,
    pairRef: auth.credential_pair_ref || null,
    accessRef: auth.access_token_ref || null,
    refreshRef: auth.refresh_token_ref || null,
    passwordRef: auth.password_ref || null,
    clientId: auth.client_id || null,
  };
}

function sameCredentialVersion(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function assertCredentialVersion(siteId, expected, current) {
  if (!sameCredentialVersion(expected, siteCredentialVersion(current))) {
    throw new CliError(`OAuth credentials for site "${siteId}" changed while this operation was running`, {
      exitCode: EXIT_CONFIG,
      nextAction: `Re-run the command so it can use the latest credentials for "${siteId}".`,
    });
  }
}

/**
 * Serialize a narrow config mutation against a fresh on-disk read. The lock
 * root is adjacent to the shared config so separate bridge processes using
 * that file coordinate even when their user state roots differ.
 */
async function mutateConfig(filePath, operation, mutate, opts = {}) {
  // Creating the containing directory does not create or replace the config;
  // the first actual file write remains inside the shared commit lock.
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const coordinator = new CredentialCoordinator({ secretStore: {}, configPath: filePath });
  return _withConfigCommitRetry(coordinator, operation, async ({ config, existed }) => {
    const outcome = await mutate(config, { existed: existed !== false });
    if (outcome && outcome.write === false) {
      return { write: false, value: outcome.value };
    }
    const v = validate(config);
    if (!v.ok) throw new CliError(`Refusing to write invalid v2 config:\n  - ${v.errors.join('\n  - ')}`, {
      exitCode: EXIT_CONFIG, nextAction: 'This is a CLI bug — the on-disk config was not modified.',
    });
    return { write: true, value: outcome && Object.hasOwn(outcome, 'value') ? outcome.value : config };
  }, opts.initialConfig ? { initialConfig: opts.initialConfig } : undefined);
}

/**
 * Mutate exactly one current site entry from a fresh config snapshot. Callers
 * that did network/browser work first can supply their original credential
 * version; a different pair/generation then fails closed rather than
 * overwriting the other operation's credentials.
 */
async function mutateSiteConfig(filePath, operation, siteId, mutate, opts = {}) {
  return mutateConfig(filePath, operation, async (config, context) => {
    const current = config.sites && config.sites[siteId];
    if (opts.expectedCredential) {
      assertCredentialVersion(siteId, opts.expectedCredential, current);
    }
    await mutate(config, current, context);
  }, opts);
}

/**
 * Build an empty v2 config skeleton. Used the first time `add-site` runs and
 * no config exists yet.
 * @returns {object}
 */
function freshConfig() {
  return emptyConfig();
}

/**
 * Derive a site-id from a URL hostname. Mirrors `add-site`'s deriveSiteId so a
 * `.mcpb`-seeded site collides with a CLI-added entry for the same host (the
 * file-absence guard in `seedFromEnvIfMissing` prevents the collision in
 * practice; the parity matters for `upgrade-auth <site-id>` to be intuitive).
 *
 * @param {string} siteUrl
 * @returns {string|null}  Site-id or null if URL is unparseable.
 */
function deriveSiteId(siteUrl) {
  let host;
  try { host = new URL(siteUrl).hostname; }
  catch { return null; }
  const trimmed = host.replace(/^www\./, '');
  const dot = trimmed.indexOf('.');
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

/**
 * Seed wp-sites.json from env vars (`ABILITIES_MCP_URL/USERNAME/PASSWORD`)
 * when the file doesn't yet exist. Used on first launch of the `.mcpb`
 * extension so subsequent CLI commands (`list-sites`, `upgrade-auth`,
 * `add-site`) operate on a single source of truth that already includes
 * the site Claude Desktop is connected to.
 *
 * Behavior:
 *  - If `configPath` already exists → no-op. Operators who manage their own
 *    `wp-sites.json` are never overwritten.
 *  - If keytar isn't loadable on this host (e.g. the .mcpb is somehow
 *    running without the bundled keytar prebuild) → no-op. The bridge
 *    falls back to env-var-only mode. Graceful degradation.
 *  - If any of the three env vars is missing → no-op. Should not happen
 *    in the .mcpb path (manifest user_config marks all three required) but
 *    guards against partial env in other invocations.
 *  - Otherwise: writes the App Password to keychain via the shared
 *    SecretStore, builds a v2 apppassword entry shaped to pass both the
 *    schema-v2 validator and the bridge's runtime validateSiteConfig
 *    (matching the migration `_convertSite` pattern — preserves
 *    `transport: 'http'` and the legacy http block alongside the v2 auth
 *    block, with `password_ref` in both).
 *
 * If the keychain write succeeds but the file write fails the keychain
 * entry is rolled back so the operator's keychain doesn't accumulate
 * orphans on repeated failures.
 *
 * @param {string} configPath  Absolute path of the wp-sites.json to seed.
 * @param {object} env         Environment shape — expects ABILITIES_MCP_URL,
 *                             ABILITIES_MCP_USERNAME, ABILITIES_MCP_PASSWORD.
 *                             Defaults to process.env.
 * @param {object} [deps]
 * @param {object} [deps.secretStore]  Inject for tests (a MemorySecretStore).
 *                                     Defaults to a fresh KeychainSecretStore.
 * @returns {Promise<{
 *   seeded: boolean,
 *   reason?: 'exists'|'missing-env-vars'|'keytar-unavailable'|'invalid-url'|'error',
 *   siteId?: string,
 *   configPath?: string,
 *   error?: Error,
 * }>}
 */
async function seedFromEnvIfMissing(configPath, env, deps = {}) {
  if (!configPath) {
    return { seeded: false, reason: 'missing-env-vars' };
  }
  const url = env && env.ABILITIES_MCP_URL;
  const username = env && env.ABILITIES_MCP_USERNAME;
  const password = env && env.ABILITIES_MCP_PASSWORD;
  if (!url || !username || !password) {
    return { seeded: false, reason: 'missing-env-vars' };
  }

  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch { return { seeded: false, reason: 'invalid-url' }; }

  const siteId = deriveSiteId(url);
  if (!siteId) {
    return { seeded: false, reason: 'invalid-url' };
  }

  // Lazily build a SecretStore so SSH-only / env-var-only setups never load
  // keytar on the seed path — the no-op "missing env vars" exit above keeps
  // them out, but keep the require deferred for symmetry with the runtime.
  let secretStore = deps.secretStore;
  if (!secretStore) {
    const { KeychainSecretStore } = require('../auth/keychain-secret-store');
    secretStore = new KeychainSecretStore();
  }

  // Probe keytar before writing. If it isn't loadable (e.g. the .mcpb
  // somehow shipped without the bundled binary) we skip seeding — the
  // bridge keeps working in env-var-only mode and the operator can run
  // `abilities-mcp add-site` from a CLI install instead.
  if (typeof secretStore.isAvailable === 'function') {
    const available = await secretStore.isAvailable();
    if (!available) {
      return { seeded: false, reason: 'keytar-unavailable' };
    }
  }

  // Build the endpoint the same way buildEnvConfig does — strip trailing
  // slash, append the adapter route. This is the URL the runtime will hit
  // for App-Password requests.
  const base = (parsedUrl.origin + parsedUrl.pathname).replace(/\/+$/, '');
  const endpoint = `${base}/wp-json/mcp/abilities-mcp-adapter-default-server`;
  const account = `${siteId}/apppassword`;
  const passwordRef = makeRef(SECRET_SERVICE, account);

  const allowInsecure = parsedUrl.protocol === 'http:';
  const site = {
    label: parsedUrl.hostname,
    url: parsedUrl.origin,
    transport: 'http',
    http: {
      endpoint,
      username,
      password_ref: passwordRef,
    },
    auth: {
      method: 'apppassword',
      username,
      password_ref: passwordRef,
    },
    auth_status: AUTH_STATUS.ACTIVE,
  };
  if (allowInsecure) site.allowInsecure = true;

  let secretWritten = false;
  try {
    const committed = await mutateConfig(configPath, 'seed-env-config', async (config, context) => {
      // This is deliberately checked while holding the same lock as
      // add-site. A competing first writer wins intact; this seed does not
      // replace its whole file or touch its credential account.
      if (context.existed) {
        return { write: false, value: { seeded: false, reason: 'exists' } };
      }
      await secretStore.set(SECRET_SERVICE, account, password);
      secretWritten = true;
      config.defaultSite = siteId;
      config.sites[siteId] = site;
      return { value: { seeded: true, siteId, configPath } };
    }, { initialConfig: freshConfig });
    if (!committed || !committed.seeded) return committed || { seeded: false, reason: 'exists' };
  } catch (err) {
    // Roll back only a secret written by this locked seed attempt. Existing
    // files are checked before that write, so another writer's credential is
    // never deleted here. Atomic rename can succeed before a later durability
    // step reports failure, so re-check under the shared lock before deleting.
    if (secretWritten) {
      try {
        await mutateConfig(configPath, 'seed-env-rollback-check', async (config) => {
          const referenced = Object.values(config.sites || {}).some((live) => {
            const authRef = live && live.auth && live.auth.password_ref;
            const httpRef = live && live.http && live.http.password_ref;
            return authRef === passwordRef || httpRef === passwordRef;
          });
          // The decision and deletion share one config lock so another
          // writer cannot publish this fixed account in between.
          if (!referenced) await secretStore.delete(SECRET_SERVICE, account);
          return { write: false };
        }, { initialConfig: freshConfig });
      } catch {
        // An unreadable/contended result is ambiguous: retain a possible
        // committed secret rather than breaking a live seeded configuration.
      }
    }
    return { seeded: false, reason: 'error', error: err };
  }

  return { seeded: true, siteId, configPath };
}

/**
 * Detect whether a per-site config still points at the pre-v1.4.9 adapter
 * server name `mcp-adapter-default-server`. Adapter v1.4.9 renamed it to
 * `abilities-mcp-adapter-default-server` to avoid colliding with the
 * official `wordpress/mcp-adapter` library (bundled by FluentKit and
 * available as a standalone plugin), which registers a server with the
 * old name and wins the registration race first-creator-wins.
 *
 * Returns the list of stored URL fields whose path segment still uses the
 * legacy name, plus the proposed replacement. Empty array = no migration
 * needed. The bridge does not auto-rewrite — the caller surfaces a
 * plain-language message and the operator edits the JSON file.
 *
 * @param {object} site The per-site config block.
 * @returns {{ field: string, oldUrl: string, newUrl: string }[]}
 */
const LEGACY_SERVER_SEGMENT = '/wp-json/mcp/mcp-adapter-default-server';
const CURRENT_SERVER_SEGMENT = '/wp-json/mcp/abilities-mcp-adapter-default-server';

function detectLegacyEndpoint(site) {
  const findings = [];
  const candidates = [
    ['mcp_resource', site && site.mcp_resource],
    ['http.endpoint', site && site.http && site.http.endpoint],
    ['auth.mcp_resource', site && site.auth && site.auth.mcp_resource],
  ];
  for (const [field, value] of candidates) {
    if (typeof value !== 'string') continue;
    if (value.includes(CURRENT_SERVER_SEGMENT)) continue;
    if (value.includes(LEGACY_SERVER_SEGMENT)) {
      findings.push({
        field,
        oldUrl: value,
        newUrl: value.replace(LEGACY_SERVER_SEGMENT, CURRENT_SERVER_SEGMENT),
      });
    }
  }
  return findings;
}

module.exports = {
  resolveConfigPath,
  readConfig,
  mutateConfig,
  mutateSiteConfig,
  siteCredentialVersion,
  assertCredentialVersion,
  freshConfig,
  seedFromEnvIfMissing,
  deriveSiteId,
  detectLegacyEndpoint,
  HOME_DIR_REL,
  LEGACY_SERVER_SEGMENT,
  CURRENT_SERVER_SEGMENT,
};
