'use strict';

const { TokenManager, AUTH_STATUS } = require('../../auth');
const { resolveRef } = require('../../auth/secret-store');
const { request } = require('../../auth/http-json');
const { CliError, EXIT_USAGE, fromAuthError } = require('../errors');
const { readConfig, writeConfig } = require('../config-store');
const { shortScopes } = require('../output');

/**
 * `test <site_id>` — ping the adapter and report granted scopes.
 *
 * Behavior:
 *   1. Resolve a current access token via TokenManager (refreshing if within
 *      the 300s window per Appendix H.2.1).
 *   2. Hit the resource (`mcp_resource` from F.5 / Phase 4 PR metadata) with
 *      a tiny MCP `initialize` request — that is the lightest call WordPress
 *      will accept and works on every adapter version.
 *   3. Report status, scopes, expiry.
 *
 * On token refresh: the new tokens are written to keychain by TokenManager,
 * and we persist the updated `access_token_expires_at` to wp-sites.json so
 * subsequent calls don't refresh again.
 *
 * Spec references:
 *   - "CLI surface" main spec section — "ping ability + show granted scopes"
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

async function run(args, ctx) {
  const siteId = args._ && args._[0];
  if (!siteId) {
    throw new CliError('test requires a site_id argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp test <site_id>',
    });
  }
  const config = readConfig(ctx.configPath);
  const site = config.sites[siteId];
  if (!site) {
    throw new CliError(`test: unknown site_id "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp list-sites to see configured sites',
    });
  }
  if (site.auth.method !== 'oauth') {
    throw new CliError(`test: site "${siteId}" uses ${site.auth.method}, not OAuth`, {
      exitCode: EXIT_USAGE,
      nextAction: 'This subcommand currently exercises OAuth bearer authentication only',
    });
  }

  const out = [];
  out.push(`Testing site "${siteId}" (${site.url})…`);

  // We need the token endpoint for refresh and the resource for the ping.
  // The token endpoint is not stored in v2 config — we resolve it from the
  // cached metadata only when needed. Phase 4 keeps the AS metadata
  // ephemeral, so we re-discover here.
  const { discover } = require('../../auth/discovery-client');
  const discoverFn = (ctx.deps && ctx.deps.discover) || discover;
  let asMetadata, prMetadata;
  try {
    const discovered = await discoverFn(site.url, {
      pinned: !!site.oauth_capability_pinned,
      pinnedFirstSeenAt: site.oauth_capability_pinned && site.oauth_capability_pinned.first_seen_at,
      allowInsecure: ctx.allowInsecure,
    });
    asMetadata = discovered.asMetadata;
    prMetadata = discovered.prMetadata;
  } catch (err) {
    throw fromAuthError(err, { siteId });
  }

  const tm = new TokenManager({ secretStore: ctx.secretStore, allowInsecure: ctx.allowInsecure });
  const siteAuthState = {
    siteId,
    tokenEndpoint: asMetadata.token_endpoint,
    clientId: site.auth.client_id,
    accessTokenRef: site.auth.access_token_ref,
    refreshTokenRef: site.auth.refresh_token_ref,
    accessTokenExpiresAt: site.auth.access_token_expires_at,
    refreshTokenExpiresAt: site.auth.refresh_token_expires_at,
    authStatus: site.auth_status || AUTH_STATUS.ACTIVE,
  };

  let accessToken;
  try {
    const tok = await tm.getAccessToken(siteAuthState);
    accessToken = tok.accessToken;
    if (tok.refreshed && tok.updatedAuth) {
      site.auth.access_token_expires_at = tok.updatedAuth.accessTokenExpiresAt;
      site.auth.refresh_token_ref = tok.updatedAuth.refreshTokenRef;
      site.auth_status = AUTH_STATUS.ACTIVE;
      await writeConfig(ctx.configPath, config);
      out.push('  (Refreshed access token before testing.)');
    }
  } catch (err) {
    // RefreshError carries an updatedAuth on 4xx — persist it so future
    // CLI calls see auth_status = expired immediately.
    if (err && err.updatedAuth) {
      site.auth_status = err.updatedAuth.authStatus;
      try { await writeConfig(ctx.configPath, config); } catch { /* best effort */ }
    }
    throw fromAuthError(err, { siteId });
  }

  const resource = site.mcp_resource || (prMetadata && prMetadata.resource);
  if (!resource) {
    throw new CliError(`test: no MCP resource URL known for site "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: `Run: abilities-mcp reauth ${siteId} to refresh the resource pointer`,
    });
  }

  // Smallest MCP request we can send — initialize. The adapter answers with
  // server capabilities, which is enough proof that the bearer survived.
  const requestFn = (ctx.deps && ctx.deps.request) || request;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'abilities-mcp test', version: ctx.softwareVersion },
    },
  });
  let res;
  try {
    res = await requestFn({
      url: resource,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body,
      allowInsecure: ctx.allowInsecure,
    });
  } catch (err) {
    throw new CliError(`test: ping to ${resource} failed: ${err.message}`, {
      exitCode: 4,
      nextAction: 'Verify the site is reachable and the adapter is running',
      cause: err,
    });
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new CliError(
      `test: bearer rejected (HTTP ${res.statusCode}) — token may be revoked or scope is missing`,
      {
        exitCode: 4,
        nextAction: `Run: abilities-mcp reauth ${siteId}`,
      }
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new CliError(`test: adapter returned HTTP ${res.statusCode}`, {
      exitCode: 4,
      nextAction: 'Inspect the adapter logs for the failing request',
    });
  }

  out.push(`✓ Reachable: ${resource} (HTTP ${res.statusCode})`);
  out.push(`  Granted scopes: ${shortScopes(site.auth.scopes)}`);
  out.push(`  Authenticated as: ${site.auth.user_login || '(unknown)'}`);
  return { exitCode: 0, lines: out };
}

module.exports = { run };
