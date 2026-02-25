'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Load configuration from wp-sites.json or build from CLI args.
 *
 * Search order for wp-sites.json:
 *   1. --config=<path> explicit path
 *   2. Same directory as wp-abilities-mcp.js
 *   3. ~/.wp-abilities-mcp/wp-sites.json
 *
 * If no config file and --host/--path provided, builds a single-site legacy config.
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
  const homeConfig = path.join(os.homedir(), '.wp-abilities-mcp', 'wp-sites.json');
  if (fs.existsSync(homeConfig)) {
    return loadConfigFile(homeConfig);
  }

  // Legacy CLI mode — single site from --host/--path
  if (args.host && args.path) {
    return buildLegacyConfig(args);
  }

  throw new Error(
    'No wp-sites.json found and no --host/--path provided.\n' +
    'Create wp-sites.json or use: --host=<ssh-host> --path=<wp-path>'
  );
}

function loadConfigFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
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
    if (!site.http || !site.http.endpoint || !site.http.username || !site.http.password) {
      throw new Error(`Site "${key}" (http): requires http.endpoint, http.username, http.password`);
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
    return { siteConfig: config.sites[compositeKey], subsiteUrl: null };
  }

  // Dot notation — "wicked.community"
  const dotIdx = compositeKey.indexOf('.');
  if (dotIdx > 0) {
    const siteKey = compositeKey.substring(0, dotIdx);
    const subsiteKey = compositeKey.substring(dotIdx + 1);
    const site = config.sites[siteKey];
    if (site && site.multisite && site.multisite[subsiteKey]) {
      return { siteConfig: site, subsiteUrl: site.multisite[subsiteKey] };
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

module.exports = { loadConfig, resolveSiteKey, buildSiteKeyEnum };
