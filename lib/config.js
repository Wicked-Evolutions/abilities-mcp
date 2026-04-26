'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
function loadConfig(args) {
  // Explicit config path
  if (args.config) {
    return loadConfigFile(args.config);
  }

  // Check alongside script (lib/ → package root)
  const scriptDir = path.resolve(__dirname, '..');
  const scriptConfig = path.join(scriptDir, 'wp-sites.json');
  if (fs.existsSync(scriptConfig)) {
    return loadConfigFile(scriptConfig);
  }

  // Check home directory
  const homeConfig = path.join(os.homedir(), '.abilities-mcp', 'wp-sites.json');
  if (fs.existsSync(homeConfig)) {
    return loadConfigFile(homeConfig);
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
    _configSource: 'env',
    sites: {
      default: siteConfig,
    },
  };
}

function loadConfigFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  // Warn if config file is readable by group or world
  try {
    const stat = fs.statSync(filePath);
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
    validateSiteConfig(key, site);
  }

  config._isMultiSite = Object.keys(config.sites).length > 1 ||
    Object.values(config.sites).some(s => s.multisite);
  config._configPath = filePath;

  return config;
}

function validateSiteConfig(key, site) {
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
 * Resolve the password for an HTTP transport config, supporting
 * plaintext password, environment variable, or shell command.
 */
function resolvePassword(httpConfig) {
  if (httpConfig.passwordEnv) {
    const val = process.env[httpConfig.passwordEnv];
    if (!val) throw new Error(`Environment variable ${httpConfig.passwordEnv} is not set`);
    return val;
  }
  if (httpConfig.passwordCommand) {
    return execSync(httpConfig.passwordCommand, { encoding: 'utf8' }).trim();
  }
  if (httpConfig.password) {
    return httpConfig.password;
  }
  throw new Error('No password, passwordEnv, or passwordCommand configured');
}

module.exports = { loadConfig, resolvePassword, resolveSiteKey, buildSiteKeyEnum, buildEnvConfig };
