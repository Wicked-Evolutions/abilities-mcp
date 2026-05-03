'use strict';

const os = require('os');

/**
 * Format the operator-visible startup diagnostic line that names which config
 * source `loadConfig` resolved to and what's in it.
 *
 * Output goes to stderr where Claude Desktop's MCP log captures it
 * (visible in `mcp-server-WordPress (Abilities MCP).log` on macOS), so the
 * operator can tell at a glance:
 *  - Whether the .mcpb extension is in env-var single-site mode or has
 *    handed off to a home-dir wp-sites.json.
 *  - How many sites are configured and what auth method each uses.
 *  - Which file path or env var is the source of truth right now.
 *
 * Discriminants set in `lib/config.js`:
 *  - 'explicit-config' — args.config / --config=<path>
 *  - 'script-adjacent' — wp-sites.json next to abilities-mcp.js
 *  - 'home-dir'        — ~/.abilities-mcp/wp-sites.json
 *  - 'env-var'         — ABILITIES_MCP_URL injected by Claude Desktop user_config
 *  - 'legacy-cli'      — --host / --path (mcp-ssh-bridge backward compat)
 *
 * The line never includes secrets — only site IDs, auth methods, hostnames,
 * tildified file paths, and counts.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

/**
 * Replace a leading $HOME prefix with `~/` so logs don't leak the operator's
 * full username path. No-op for paths outside $HOME.
 */
function tildify(p) {
  if (!p) return p;
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + '/'))) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/**
 * Per-site short auth label: prefer auth.method (v2 schema), fall back to
 * transport (v1 schema), 'unknown' if neither is set.
 */
function siteAuthLabel(site) {
  if (site && site.auth && site.auth.method) return site.auth.method;
  if (site && site.transport) return site.transport;
  return 'unknown';
}

/**
 * Build the Config-source line.
 *
 * @param {object} config  Output of `loadConfig` — must carry `_configSource`
 *                         and `_configSourceLabel`.
 * @returns {string}       One-line operator diagnostic, no trailing newline.
 */
function formatConfigSourceLine(config) {
  const source = config && config._configSource;
  const rawLabel = (config && config._configSourceLabel) || '';

  if (source === 'env-var') {
    const site = config.sites && config.sites[config.defaultSite];
    const username = (site && site.http && site.http.username) || '?';
    return `Config source: ABILITIES_MCP_URL env var (single-site basic auth: ${rawLabel} as ${username})`;
  }

  if (source === 'legacy-cli') {
    return `Config source: --host/--path legacy CLI (single-site SSH: ${rawLabel})`;
  }

  // File-based: explicit-config / script-adjacent / home-dir
  const label = tildify(rawLabel);
  const siteEntries = Object.entries(config.sites || {}).map(
    ([id, site]) => `${id} ${siteAuthLabel(site)}`
  );
  const sitesHeader = siteEntries.length === 1 ? '1 site' : `${siteEntries.length} sites`;
  const sourcePrefix = source ? `[${source}] ` : '';
  return `Config source: ${sourcePrefix}${label} (${sitesHeader}: ${siteEntries.join(', ')})`;
}

module.exports = { formatConfigSourceLine, tildify, siteAuthLabel };
