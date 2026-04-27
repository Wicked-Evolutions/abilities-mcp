'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { SCHEMA_VERSION, validate, emptyConfig } = require('../auth/schema-v2');
const { _atomicWrite } = require('../auth/config-migration');
const { CliError, EXIT_CONFIG } = require('./errors');

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
 * Atomically write a v2 config file. Validates before writing.
 *
 * @param {string} filePath
 * @param {object} config
 */
async function writeConfig(filePath, config) {
  const v = validate(config);
  if (!v.ok) {
    throw new CliError(
      `Refusing to write invalid v2 config:\n  - ${v.errors.join('\n  - ')}`,
      {
        exitCode: EXIT_CONFIG,
        nextAction: 'This is a CLI bug — please report it. The on-disk config was not modified.',
      }
    );
  }
  // Ensure parent dir exists (e.g. ~/.abilities-mcp/ on first add-site).
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  await _atomicWrite(filePath, config);
}

/**
 * Build an empty v2 config skeleton. Used the first time `add-site` runs and
 * no config exists yet.
 * @returns {object}
 */
function freshConfig() {
  return emptyConfig();
}

module.exports = {
  resolveConfigPath,
  readConfig,
  writeConfig,
  freshConfig,
  HOME_DIR_REL,
};