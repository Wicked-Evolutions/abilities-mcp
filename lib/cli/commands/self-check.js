'use strict';

const { URL } = require('node:url');

const { TokenManager, AUTH_STATUS } = require('../../auth');
const { discover } = require('../../auth/discovery-client');
const { request } = require('../../auth/http-json');
const { CliError, EXIT_USAGE, fromAuthError } = require('../errors');
const { readConfig } = require('../config-store');

/**
 * `self-check <site_id>` — Authorization-header survival probe (H.2.6).
 *
 * Hits `/wp-json/abilities-mcp-adapter/v1/oauth/echo-headers` with the OAuth
 * bearer; that adapter endpoint returns presence/absence of expected headers
 * (never the values). Reports whether the Authorization header survived the
 * trip — many shared hosts strip it on FastCGI/PHP-FPM unless an .htaccess
 * snippet recovers it.
 *
 * Per H.2.6: "the debug endpoint is OAuth-token-protected (so it's not a
 * fingerprint surface) and returns only the **presence/absence** of expected
 * headers, never the values."
 *
 * Spec is silent on whether self-check takes a site_id. The natural reading
 * is yes (it requires an OAuth token, which lives per-site).
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const ECHO_HEADERS_PATH = '/wp-json/abilities-mcp-adapter/v1/oauth/echo-headers';

async function run(args, ctx) {
  const siteId = args._ && args._[0];
  if (!siteId) {
    throw new CliError('self-check requires a site_id argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp self-check <site_id>',
    });
  }
  const config = readConfig(ctx.configPath);
  const site = config.sites[siteId];
  if (!site) {
    throw new CliError(`self-check: unknown site_id "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp list-sites to see configured sites',
    });
  }
  if (site.auth.method !== 'oauth') {
    throw new CliError(`self-check: site "${siteId}" uses ${site.auth.method}, not OAuth`, {
      exitCode: EXIT_USAGE,
      nextAction: 'self-check probes the OAuth bearer path — only OAuth sites are supported',
    });
  }

  const out = [];
  out.push(`Probing Authorization-header survival on site "${siteId}"…`);

  // Re-discover purely to find the token endpoint (for a possible refresh).
  const discoverFn = (ctx.deps && ctx.deps.discover) || discover;
  let asMetadata;
  try {
    const discovered = await discoverFn(site.url, {
      pinned: !!site.oauth_capability_pinned,
      pinnedFirstSeenAt: site.oauth_capability_pinned && site.oauth_capability_pinned.first_seen_at,
      allowInsecure: ctx.allowInsecure,
    });
    asMetadata = discovered.asMetadata;
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
  } catch (err) {
    throw fromAuthError(err, { siteId });
  }

  const url = new URL(ECHO_HEADERS_PATH, site.url).toString();
  const requestFn = (ctx.deps && ctx.deps.request) || request;
  let res;
  try {
    res = await requestFn({
      url,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
      allowInsecure: ctx.allowInsecure,
    });
  } catch (err) {
    throw new CliError(`self-check: probe to ${url} failed: ${err.message}`, {
      exitCode: 4,
      nextAction: 'Verify the site is reachable and the adapter exposes /oauth/echo-headers',
      cause: err,
    });
  }

  if (res.statusCode === 404) {
    return {
      exitCode: 0,
      lines: out.concat([
        `(Adapter does not expose ${ECHO_HEADERS_PATH} on this site.)`,
        '  This endpoint ships with abilities-mcp-adapter v1.5.0+. Older adapters cannot self-check.',
      ]),
    };
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new CliError(
      `self-check: bearer rejected (HTTP ${res.statusCode}) reaching ${url}`,
      {
        exitCode: 4,
        nextAction: `Run: abilities-mcp reauth ${siteId}`,
      }
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300 || !res.json) {
    throw new CliError(
      `self-check: adapter returned HTTP ${res.statusCode} (no JSON body)`,
      {
        exitCode: 4,
        nextAction: 'Inspect the adapter logs for the failing request',
      }
    );
  }

  // The adapter's response shape (H.2.6): presence flags only.
  const auth = !!(res.json.authorization_present || res.json.headers && res.json.headers.authorization);
  out.push(`  Authorization header: ${auth ? '✓ Detected' : '⚠ NOT detected'}`);
  // Common companion fields adapters may include.
  if (typeof res.json.host_software === 'string') {
    out.push(`  Adapter reports host: ${res.json.host_software}`);
  }
  if (Array.isArray(res.json.recovery_hints) && res.json.recovery_hints.length) {
    out.push('  Recovery hints from adapter:');
    for (const h of res.json.recovery_hints) out.push(`    - ${h}`);
  }
  if (!auth) {
    out.push('');
    out.push('Your hosting may be stripping the Authorization header on FastCGI/PHP-FPM.');
    out.push('Apache: ship the .htaccess RewriteRule from H.2.6.');
    out.push('LiteSpeed / Nginx: see the operator setup guide.');
  }
  return { exitCode: auth ? 0 : 4, lines: out };
}

module.exports = { run, ECHO_HEADERS_PATH };
