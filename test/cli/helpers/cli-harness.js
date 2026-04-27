'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  MemorySecretStore,
  FreshEachTimeIdentityProvider,
} = require('../../../lib/auth');
const { runCommand } = require('../../../lib/cli');
const { createTestContext } = require('../../../lib/cli/context');

/**
 * Test-only harness for the Phase 5 CLI.
 *
 * Builds a CliContext that:
 *   - Uses MemorySecretStore (no keytar dependency at test time).
 *   - Points at a unique temp config path so tests do not collide.
 *   - Allows insecure (localhost) HTTP — MockAuthServer binds 127.0.0.1.
 *   - Optionally injects deps (OAuthClient subclass, request fn, discover fn)
 *     so tests can drive the loopback callback themselves.
 *
 * The harness exposes a `runCli(subcommand, argv, deps?)` helper that returns
 * the same shape the entrypoint hands to stdout/stderr/process.exit.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

let _seq = 0;

/**
 * Create a fresh harness. Tests should call `cleanup()` from `after()` (or
 * `afterEach`) to remove the temp dir.
 *
 * @param {object} [opts]
 * @param {object} [opts.secretStore]
 * @param {object} [opts.identityProvider]
 * @param {object} [opts.deps]                Forwarded into CliContext.deps
 * @returns {{
 *   ctx: object,
 *   configPath: string,
 *   readConfig: () => object,
 *   writeConfig: (cfg: object) => void,
 *   runCli: (subcommand: string, argv: string[], extraDeps?: object) => Promise<{exitCode, lines, errLines}>,
 *   cleanup: () => void,
 * }}
 */
function makeHarness(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-cli-'));
  const configPath = path.join(dir, 'wp-sites.json');

  const secretStore = opts.secretStore || new MemorySecretStore();
  const identityProvider = opts.identityProvider
    || new FreshEachTimeIdentityProvider({ store: secretStore });

  const ctx = createTestContext({
    secretStore,
    identityProvider,
    configPath,
    allowInsecure: true,
    deps: opts.deps || {},
  });

  function runCli(subcommand, argv, extraDeps) {
    if (extraDeps) ctx.deps = Object.assign({}, ctx.deps, extraDeps);
    return runCommand({ subcommand, argv, ctx });
  }

  function readConfigJson() {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  function writeConfigJson(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  }

  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { ctx, configPath, runCli, readConfig: readConfigJson, writeConfig: writeConfigJson, cleanup };
}

/**
 * Drive the loopback callback for an OAuthClient flow once it reaches
 * `awaiting_consent`. Mirrors test/auth/oauth-client.test.js behavior.
 *
 * Returns a deps wrapper for the OAuthClient that intercepts `openBrowser`
 * and triggers the callback directly.
 */
function autoConsentDeps(opts = {}) {
  const code = opts.code || 'AUTOPASS';
  return {
    openBrowser: async (url) => {
      const u = new URL(url);
      const redirectUri = u.searchParams.get('redirect_uri');
      const state = u.searchParams.get('state');
      const cbUrl = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      // Defer slightly so the loopback server is listening when we hit it.
      setImmediate(() => {
        http.get(cbUrl, (res) => res.resume()).on('error', () => {});
      });
      return { spawned: true, platform: 'override' };
    },
  };
}

/**
 * Use this when constructing OAuthClient deps in a CLI test. Wraps the inner
 * lib/auth helpers so the test never opens a real browser or hits the real
 * keychain.
 */
function oauthClientDepsFor(opts = {}) {
  return autoConsentDeps(opts);
}

/**
 * Build a v2 site block for tests that pre-seed a site config.
 */
function v2SiteOAuth(siteUrl, overrides = {}) {
  return Object.assign({
    url: siteUrl,
    label: new URL(siteUrl).hostname,
    auth: {
      method: 'oauth',
      client_id: 'client-test',
      user_login: 'wp_agent',
      scopes: ['abilities:read', 'abilities:write'],
      access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
      access_token_ref: 'keychain://abilities-mcp/test/access',
      refresh_token_ref: 'keychain://abilities-mcp/test/refresh',
    },
    auth_status: 'active',
    oauth_capability_pinned: {
      first_seen_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      last_confirmed_at: new Date().toISOString(),
    },
  }, overrides);
}

function v2SiteAppPassword(siteUrl, overrides = {}) {
  return Object.assign({
    url: siteUrl,
    label: new URL(siteUrl).hostname,
    auth: {
      method: 'apppassword',
      username: 'wp_editor',
      password_ref: 'keychain://abilities-mcp/test/apppassword',
    },
    auth_status: 'active',
  }, overrides);
}

module.exports = {
  makeHarness,
  autoConsentDeps,
  oauthClientDepsFor,
  v2SiteOAuth,
  v2SiteAppPassword,
};
