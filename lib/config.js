'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

/**
 * Load configuration from wp-sites.json, environment variables, or CLI args.
 *
 * Search order:
 *   1. --config=<path> explicit path
 *   2. Same directory as abilities-mcp.js
 *   3. ~/.abilities-mcp/wp-sites.json
 *   4. ABILITIES_MCP_URL/USERNAME/PASSWORD env vars (single-site, .mcpb path)
 *   5. --host/--path CLI args (legacy SSH single-site)
 *
 * Per Issue #5 / Phase E.2 (Stretch to Stable sprint): the startup chain
 * — `resolveConfigFilePath`, `loadConfig`, `loadConfigFile`,
 * `validateSiteConfig`, `resolvePassword` — is async so file reads and
 * `passwordCommand` shell-outs do not block the event loop during boot.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

/**
 * Async non-throwing existence check. Returns true iff the path resolves
 * via fs.access(); any error (ENOENT, EACCES, …) yields false. Used by the
 * search-order helpers which only care whether a candidate file is readable.
 */
async function _exists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the on-disk wp-sites.json path that `loadConfig` would consume,
 * without reading or validating it. Returns `null` when no file path applies
 * (env-var single-site, legacy --host/--path, or no config at all).
 *
 * Used by the v1→v2 migration shim in `abilities-mcp.js` so the migration can
 * run before `loadConfig` parses + validates a stale v1 file.
 *
 * Mirrors steps 1-3 of `loadConfig`'s search order. Steps 4-5 (env / legacy
 * CLI) intentionally return `null` — there is no on-disk file to migrate.
 *
 * @param {object} args
 * @returns {Promise<string|null>}  Absolute path of the resolved wp-sites.json, or null.
 */
async function resolveConfigFilePath(args) {
  if (args && args.config) {
    return path.resolve(args.config);
  }
  const scriptDir = path.resolve(__dirname, '..');
  const scriptConfig = path.join(scriptDir, 'wp-sites.json');
  if (await _exists(scriptConfig)) {
    return scriptConfig;
  }
  const homeConfig = path.join(os.homedir(), '.abilities-mcp', 'wp-sites.json');
  if (await _exists(homeConfig)) {
    return homeConfig;
  }
  return null;
}

async function loadConfig(args) {
  // Explicit config path
  if (args.config) {
    return loadConfigFile(args.config, 'explicit-config');
  }

  // Check alongside script (lib/ → package root)
  const scriptDir = path.resolve(__dirname, '..');
  const scriptConfig = path.join(scriptDir, 'wp-sites.json');
  if (await _exists(scriptConfig)) {
    return loadConfigFile(scriptConfig, 'script-adjacent');
  }

  // Check home directory
  const homeConfig = path.join(os.homedir(), '.abilities-mcp', 'wp-sites.json');
  if (await _exists(homeConfig)) {
    return loadConfigFile(homeConfig, 'home-dir');
  }

  // Env-var single-site config — covers the .mcpb install path and any
  // env-var-based MCP client configuration (claude mcp add, Docker, etc.)
  if (process.env.ABILITIES_MCP_URL) {
    return buildEnvConfig(process.env);
  }

  // Legacy CLI mode — single site from --host/--path
  if (args.host && args.path) {
    return buildLegacyConfig(args);
  }

  throw new Error(
    'No configuration found.\n' +
    'Provide one of: wp-sites.json, ABILITIES_MCP_URL+USERNAME+PASSWORD env vars, or --host/--path.'
  );
}

/**
 * Build single-site config from env vars (ABILITIES_MCP_URL/USERNAME/PASSWORD).
 *
 * Auto-derives the MCP adapter endpoint from the site URL:
 *   https://example.com  →  https://example.com/wp-json/mcp/mcp-adapter-default-server
 *
 * This is the path used by .mcpb bundles installed in Claude Desktop and any
 * other env-var-based MCP client configuration.
 */
function buildEnvConfig(env) {
  const rawUrl = env.ABILITIES_MCP_URL;
  const username = env.ABILITIES_MCP_USERNAME;
  const password = env.ABILITIES_MCP_PASSWORD;

  if (!username) {
    throw new Error('ABILITIES_MCP_URL is set but ABILITIES_MCP_USERNAME is missing');
  }
  if (!password) {
    throw new Error('ABILITIES_MCP_URL is set but ABILITIES_MCP_PASSWORD is missing');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (e) {
    throw new Error(`ABILITIES_MCP_URL is not a valid URL: ${rawUrl}`);
  }

  const isHttps = parsedUrl.protocol === 'https:';
  const isHttp = parsedUrl.protocol === 'http:';
  if (!isHttps && !isHttp) {
    throw new Error(`ABILITIES_MCP_URL must be http or https: ${rawUrl}`);
  }

  // Strip trailing slash from origin+path, then append the adapter route.
  const base = (parsedUrl.origin + parsedUrl.pathname).replace(/\/+$/, '');
  const endpoint = `${base}/wp-json/mcp/mcp-adapter-default-server`;

  const siteConfig = {
    label: parsedUrl.hostname,
    url: parsedUrl.origin,
    transport: 'http',
    http: {
      endpoint,
      username,
      password,
    },
  };

  // Allow plain HTTP only when the operator explicitly opts in. The .mcpb path
  // expects HTTPS by default; localhost dev gets a narrow exception.
  if (isHttp) {
    const isLocal = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
    if (!isLocal && env.ABILITIES_MCP_ALLOW_INSECURE !== 'true') {
      throw new Error(
        `ABILITIES_MCP_URL is HTTP (not HTTPS): ${rawUrl}\n` +
        `Set ABILITIES_MCP_ALLOW_INSECURE=true to allow plain HTTP.`
      );
    }
    siteConfig.allowInsecure = true;
  }

  return {
    defaultSite: 'default',
    _isMultiSite: false,
    _configSource: 'env-var',
    _configSourceLabel: parsedUrl.hostname,
    sites: {
      default: siteConfig,
    },
  };
}

async function loadConfigFile(filePath, source = 'explicit-config') {
  const raw = await fsp.readFile(filePath, 'utf8');

  // Warn if config file is readable by group or world
  try {
    const stat = await fsp.stat(filePath);
    if (stat.mode & 0o077) {
      process.stderr.write(
        `WARNING: ${filePath} is readable by group/world (mode ${(stat.mode & 0o777).toString(8)}). ` +
        `Consider running: chmod 600 ${filePath}\n`
      );
    }
  } catch (e) { /* stat failed — skip check */ }

  const config = JSON.parse(raw);

  if (!config.sites || typeof config.sites !== 'object') {
    throw new Error(`Invalid wp-sites.json: missing "sites" object`);
  }

  if (!config.defaultSite) {
    config.defaultSite = Object.keys(config.sites)[0];
  }

  if (!config.sites[config.defaultSite]) {
    throw new Error(`Default site "${config.defaultSite}" not found in sites`);
  }

  // Validate each site
  for (const [key, site] of Object.entries(config.sites)) {
    await validateSiteConfig(key, site);
  }

  config._isMultiSite = Object.keys(config.sites).length > 1 ||
    Object.values(config.sites).some(s => s.multisite);
  config._configPath = filePath;
  config._configSource = source;
  config._configSourceLabel = filePath;

  return config;
}

async function validateSiteConfig(key, site) {
  // v2 OAuth sites carry no transport block (Appendix F.5 + add-site flow).
  // The runtime treats them as HTTP — endpoint comes from auth.mcp_resource
  // or site.mcp_resource (resolved by the OAuth-aware transport).
  if (site.auth && site.auth.method === 'oauth') {
    if (!site.url) {
      throw new Error(`Site "${key}" (oauth): requires "url"`);
    }
    if (!site.auth.access_token_ref || !site.auth.refresh_token_ref) {
      throw new Error(`Site "${key}" (oauth): requires auth.access_token_ref and auth.refresh_token_ref`);
    }
    if (!site.mcp_resource) {
      throw new Error(`Site "${key}" (oauth): requires mcp_resource (set during add-site / reauth)`);
    }
    if (!site.mcp_resource.startsWith('https://') && !site.allowInsecure) {
      throw new Error(`Site "${key}" (oauth): mcp_resource is not HTTPS. Set "allowInsecure": true on the site to allow HTTP`);
    }
    return;
  }

  // v2 App-Password sites — produced by config-migration from v1 transport-style
  // configs. Secret lives in keychain (auth.password_ref); the legacy http.password*
  // fields are stripped during migration so the keychain is the sole source of
  // truth. Carrier transport (http or ssh) is preserved for the runtime.
  if (site.auth && site.auth.method === 'apppassword') {
    if (!site.auth.username) {
      throw new Error(`Site "${key}" (apppassword): requires auth.username`);
    }
    if (!site.auth.password_ref) {
      throw new Error(`Site "${key}" (apppassword): requires auth.password_ref`);
    }
    if (!site.transport) {
      throw new Error(`Site "${key}" (apppassword): missing "transport" (ssh or http)`);
    }
    if (site.transport === 'ssh') {
      if (!site.ssh || !site.ssh.host || !site.ssh.path) {
        throw new Error(`Site "${key}" (apppassword/ssh): requires ssh.host and ssh.path`);
      }
    } else if (site.transport === 'http') {
      if (!site.http || !site.http.endpoint) {
        throw new Error(`Site "${key}" (apppassword/http): requires http.endpoint`);
      }
      if (!site.http.endpoint.startsWith('https://') && !site.allowInsecure) {
        throw new Error(`Site "${key}" (apppassword/http): endpoint is not HTTPS. Set "allowInsecure": true on the site to allow HTTP`);
      }
    } else {
      throw new Error(`Site "${key}" (apppassword): unknown transport "${site.transport}" (use ssh or http)`);
    }
    return;
  }

  if (!site.transport) {
    throw new Error(`Site "${key}": missing "transport" (ssh or http)`);
  }

  if (site.transport === 'ssh') {
    if (!site.ssh || !site.ssh.host || !site.ssh.path) {
      throw new Error(`Site "${key}" (ssh): requires ssh.host and ssh.path`);
    }
  } else if (site.transport === 'http') {
    if (!site.http || !site.http.endpoint || !site.http.username) {
      throw new Error(`Site "${key}" (http): requires http.endpoint and http.username`);
    }
    if (!site.http.password && !site.http.passwordEnv && !site.http.passwordCommand) {
      throw new Error(`Site "${key}" (http): requires one of http.password, http.passwordEnv, or http.passwordCommand`);
    }
    if (!site.http.endpoint.startsWith('https://') && !site.allowInsecure) {
      throw new Error(`Site "${key}" (http): endpoint is not HTTPS. Set "allowInsecure": true on the site to allow HTTP`);
    }
  } else {
    throw new Error(`Site "${key}": unknown transport "${site.transport}" (use ssh or http)`);
  }
}

/**
 * Build single-site config from legacy CLI args (backward compat with mcp-ssh-bridge).
 */
function buildLegacyConfig(args) {
  return {
    defaultSite: 'default',
    _isMultiSite: false,
    _configSource: 'legacy-cli',
    _configSourceLabel: args.host,
    sites: {
      default: {
        label: args.host,
        url: `ssh://${args.host}`,
        transport: 'ssh',
        ssh: {
          host: args.host,
          path: args.path,
          user: args.user || '',
        },
        mcpServer: args.server || 'mcp-adapter-default-server',
      }
    }
  };
}

/**
 * Resolve a composite site key like "wicked.community" into config + subsite URL.
 * Pure in-memory dispatch — kept synchronous since it has no I/O.
 */
function resolveSiteKey(config, compositeKey) {
  // Direct match — "helena" or "wicked"
  if (config.sites[compositeKey]) {
    return { siteConfig: config.sites[compositeKey], subsiteUrl: null, resolvedEndpoint: null };
  }

  // Dot notation — "wicked.community"
  const dotIdx = compositeKey.indexOf('.');
  if (dotIdx > 0) {
    const siteKey = compositeKey.substring(0, dotIdx);
    const subsiteKey = compositeKey.substring(dotIdx + 1);
    const site = config.sites[siteKey];
    if (site && site.multisite && site.multisite[subsiteKey]) {
      const subsiteUrl = site.multisite[subsiteKey];
      let resolvedEndpoint = null;

      // For HTTP transport: build subsite endpoint from subsite URL + parent endpoint path.
      // This makes WordPress boot natively into the correct blog context —
      // community.wickedevolutions.com/wp-json/mcp/... boots into blog 2,
      // not wickedevolutions.com/wp-json/mcp/... which boots into blog 1.
      if (site.transport === 'http' && site.http && site.http.endpoint) {
        const parentUrl = new URL(site.http.endpoint);
        const subsiteOrigin = new URL(subsiteUrl).origin;
        resolvedEndpoint = subsiteOrigin + parentUrl.pathname;
      }

      return { siteConfig: site, subsiteUrl, resolvedEndpoint };
    }
  }

  throw new Error(`Unknown site: "${compositeKey}". Available: ${Object.keys(config.sites).join(', ')}`);
}

/**
 * Build full list of site keys including multisite composites.
 * e.g. ["helena", "wicked", "wicked.main", "wicked.community"]
 */
function buildSiteKeyEnum(config) {
  const keys = [];
  for (const [key, site] of Object.entries(config.sites)) {
    keys.push(key);
    if (site.multisite) {
      for (const subKey of Object.keys(site.multisite)) {
        keys.push(`${key}.${subKey}`);
      }
    }
  }
  return keys;
}

/**
 * Resolve the password for an HTTP transport config, supporting plaintext
 * password, environment variable, or shell command.
 *
 * `passwordCommand` is dispatched through `util.promisify(exec)` so the shell
 * interprets the command string the same way the previous `execSync` did
 * (operators rely on pipes, redirects, and command chaining — e.g.
 * `op read 'op://Vault/foo' | tr -d '\n'` — which `execFile` cannot run).
 */
async function resolvePassword(httpConfig) {
  if (httpConfig.passwordEnv) {
    const val = process.env[httpConfig.passwordEnv];
    if (!val) throw new Error(`Environment variable ${httpConfig.passwordEnv} is not set`);
    return val;
  }
  if (httpConfig.passwordCommand) {
    const { stdout } = await execAsync(httpConfig.passwordCommand, { encoding: 'utf8' });
    return stdout.trim();
  }
  if (httpConfig.password) {
    return httpConfig.password;
  }
  throw new Error('No password, passwordEnv, or passwordCommand configured');
}

/**
 * Resolve a site's HTTP password, dispatching on schema shape.
 *
 * v2 App-Password sites (auth.method === 'apppassword' + auth.password_ref)
 * read the secret from the keychain via the SecretStore. v1 carriers without
 * a ref fall back to the `resolvePassword(http)` resolver.
 *
 * @param {object} site
 * @param {object} [secretStore]  SecretStore instance. Lazily defaults to
 *                                KeychainSecretStore when an apppassword path
 *                                runs and no store was supplied — preserves
 *                                the "no keytar for SSH-only / v1-only setups"
 *                                property by deferring the require to the
 *                                point of need.
 * @returns {Promise<string>}
 */
async function resolveSitePassword(site, secretStore) {
  if (site && site.auth && site.auth.method === 'apppassword' && site.auth.password_ref) {
    let store = secretStore;
    if (!store) {
      const { KeychainSecretStore } = require('./auth/keychain-secret-store');
      store = new KeychainSecretStore();
    }
    const { resolveRef } = require('./auth/secret-store');
    return resolveRef(store, site.auth.password_ref);
  }
  if (site && site.http) {
    return resolvePassword(site.http);
  }
  throw new Error('No password source configured for site');
}

module.exports = {
  loadConfig,
  resolveConfigFilePath,
  resolvePassword,
  resolveSitePassword,
  resolveSiteKey,
  buildSiteKeyEnum,
  buildEnvConfig,
};
