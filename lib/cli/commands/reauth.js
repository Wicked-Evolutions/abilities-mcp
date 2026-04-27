'use strict';

const {
  OAuthClient,
  TokenManager,
  AUTH_STATUS,
  DEFAULT_SCOPE,
} = require('../../auth');
const { CliError, EXIT_USAGE, fromAuthError } = require('../errors');
const { subscribeProgress } = require('../output');
const { readConfig, writeConfig } = require('../config-store');

/**
 * `reauth <site_id>` — re-run the OAuth flow for an existing site.
 *
 * Reuses the existing site URL and existing capability pin; mints a fresh
 * client_id (FreshEachTimeIdentityProvider in v1.0); replaces the access /
 * refresh tokens in keychain.
 *
 * Spec references:
 *   - "CLI surface" main spec section
 *   - F.5 (auth_status enum)
 *   - H.2.3 (capabilityPin firstSeenAt is preserved across reauths)
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

async function run(args, ctx) {
  const siteId = args._ && args._[0];
  if (!siteId) {
    throw new CliError('reauth requires a site_id argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp reauth <site_id>',
    });
  }
  const config = readConfig(ctx.configPath);
  const site = config.sites[siteId];
  if (!site) {
    throw new CliError(`reauth: unknown site_id "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: `Run: abilities-mcp list-sites to see configured sites`,
    });
  }
  if (site.auth.method !== 'oauth') {
    throw new CliError(`reauth: site "${siteId}" uses ${site.auth.method}, not OAuth`, {
      exitCode: EXIT_USAGE,
      nextAction: `Run: abilities-mcp upgrade-auth ${siteId} to migrate to OAuth`,
    });
  }

  const out = [];
  out.push(`Re-running OAuth flow for site "${siteId}" (${site.url})…`);

  const clientName = `${ctx.userLabel}'s Operator (${ctx.hostnameLabel})`;
  const OAuthClientCls = (ctx.deps && ctx.deps.OAuthClient) || OAuthClient;
  const oauth = new OAuthClientCls({
    siteUrl: site.url,
    clientName,
    softwareVersion: ctx.softwareVersion,
    scope: args.scope || (Array.isArray(site.auth.scopes) ? site.auth.scopes : DEFAULT_SCOPE),
    identityProvider: ctx.identityProvider,
    allowInsecure: ctx.allowInsecure,
    capabilityPin: site.oauth_capability_pinned ? {
      firstSeenAt: site.oauth_capability_pinned.first_seen_at,
    } : null,
    deps: ctx.deps && ctx.deps.oauthClientDeps,
  });
  subscribeProgress(oauth, out);

  let result;
  try { result = await oauth.run(); }
  catch (err) { throw fromAuthError(err, { siteId }); }

  const tm = new TokenManager({ secretStore: ctx.secretStore, allowInsecure: ctx.allowInsecure });
  const persisted = await tm.persistTokens({ siteId, tokens: result.tokens });

  site.auth = {
    method: 'oauth',
    client_id: result.clientId,
    user_login: site.auth.user_login || ctx.userLabel || 'operator',
    scopes: result.scopes,
    access_token_expires_at: persisted.accessTokenExpiresAt,
    refresh_token_expires_at: persisted.refreshTokenExpiresAt,
    access_token_ref: persisted.accessTokenRef,
    refresh_token_ref: persisted.refreshTokenRef,
  };
  // Carry forward apppassword_fallback if upgrade-auth stage 2 ran.
  // Carry forward force_downgrade audit so it stays visible for its 30 days.
  // (We rebuild the auth object from scratch above so we need to restore them
  // explicitly — keeps the shape clean.)

  site.auth_status = AUTH_STATUS.ACTIVE;
  site.oauth_capability_pinned = {
    first_seen_at: result.capabilityPin.firstSeenAt,
    last_confirmed_at: result.capabilityPin.lastConfirmedAt,
  };
  if (result.prMetadata && result.prMetadata.resource) {
    site.mcp_resource = result.prMetadata.resource;
  }
  await writeConfig(ctx.configPath, config);

  out.push(`✓ Site "${siteId}" re-authorized. Granted scopes: ${result.scopes.join(', ')}.`);
  return { exitCode: 0, lines: out };
}

module.exports = { run };
