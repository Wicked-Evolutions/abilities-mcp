'use strict';

const {
  OAuthClient,
  TokenManager,
  CredentialCoordinator,
  AUTH_STATUS,
  DEFAULT_SCOPE,
} = require('../../auth');
const { CliError, EXIT_USAGE, fromAuthError } = require('../errors');
const { subscribeProgress } = require('../output');
const { readConfig, mutateSiteConfig, siteCredentialVersion } = require('../config-store');
const { computeScopeMutation } = require('../scope-mutation');

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
  const expectedCredential = siteCredentialVersion(site);

  // Resolve the requested scope set from the three mutually-exclusive flags
  // (--scope replaces, --add-scope merges, --remove-scope drops). See
  // lib/cli/scope-mutation.js for the full design (Issue #50). Empty
  // existing → DEFAULT_SCOPE fallback to preserve the prior bare-reauth
  // contract.
  const persistedScopes = Array.isArray(site.auth.scopes) ? site.auth.scopes : null;
  const mutation = computeScopeMutation({
    scope: args.scope,
    addScope: args['add-scope'],
    removeScope: args['remove-scope'],
    existing: persistedScopes,
  });
  if (mutation.errorCode) {
    throw new CliError(mutation.errorMessage, {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp reauth <site_id> --add-scope=<scopes> | --remove-scope=<scopes> | --scope=<scopes>',
    });
  }
  const requestedScope = mutation.scopes.length > 0 ? mutation.scopes : (persistedScopes || DEFAULT_SCOPE);

  const out = [];
  const errLines = mutation.warnings.slice();
  out.push(`Re-running OAuth flow for site "${siteId}" (${site.url})…`);
  const authorizationCoordinator = new CredentialCoordinator({ secretStore: ctx.secretStore, configPath: ctx.configPath, siteId,
    deps: { stateRoot: ctx.deps && ctx.deps.oauthCoordinationStateRoot } });
  return authorizationCoordinator.withAuthorizationLock('reauth', async () => {

  const clientName = `${ctx.userLabel}'s Operator (${ctx.hostnameLabel})`;
  const OAuthClientCls = (ctx.deps && ctx.deps.OAuthClient) || OAuthClient;
  const oauth = new OAuthClientCls({
    siteUrl: site.url,
    clientName,
    softwareVersion: ctx.softwareVersion,
    scope: requestedScope,
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

  const tm = new TokenManager({ secretStore: ctx.secretStore, allowInsecure: ctx.allowInsecure,
    credentialCoordinator: authorizationCoordinator });
  const persisted = await tm.persistTokens({
    siteId,
    tokens: result.tokens,
    tokenRequestStartedAt: result.tokenRequestStartedAt,
  });

  // Carry forward apppassword_fallback so an in-progress upgrade-auth
  // (Step 2 done, Step 4 not yet run) is not silently undone by a reauth.
  // Operators remove the fallback only via `upgrade-auth --confirm`.
  const newAuth = {
    method: 'oauth',
    client_id: result.clientId,
    user_login: site.auth.user_login || ctx.userLabel || 'operator',
    scopes: result.scopes,
    access_token_expires_at: persisted.accessTokenExpiresAt,
    refresh_token_expires_at: persisted.refreshTokenExpiresAt,
    credential_pair_ref: persisted.credentialPairRef,
    credential_generation: persisted.credentialGeneration,
    credential_identity: persisted.credentialIdentity,
    credential_pair_slot: persisted.credentialPairSlot,
    authorization_expires_at: persisted.authorizationExpiresAt || undefined,
    next_refresh_at: persisted.nextRefreshAt,
    refresh_expiry_source: persisted.refreshExpirySource,
  };
  await mutateSiteConfig(ctx.configPath, 'cli-reauth', siteId, (currentConfig, current) => {
    if (!current || current.auth.method !== 'oauth') {
      throw new CliError(`reauth: site "${siteId}" is no longer an OAuth site`, {
        exitCode: EXIT_USAGE,
        nextAction: `Inspect "${siteId}" and re-run reauth if it still needs OAuth credentials.`,
      });
    }
    // Carry forward the freshest fallback so a concurrent non-credential
    // update cannot silently remove an upgrade-auth recovery path.
    const carryFallback = current.auth.apppassword_fallback || null;
    current.auth = { ...newAuth };
    if (carryFallback) current.auth.apppassword_fallback = carryFallback;
    current.auth_status = AUTH_STATUS.ACTIVE;
    current.oauth_capability_pinned = {
      first_seen_at: result.capabilityPin.firstSeenAt,
      last_confirmed_at: result.capabilityPin.lastConfirmedAt,
    };
    if (result.prMetadata && result.prMetadata.resource) {
      current.mcp_resource = result.prMetadata.resource;
    }
  }, { expectedCredential });

  out.push(`✓ Site "${siteId}" re-authorized. Granted scopes: ${result.scopes.join(', ')}.`);
  return { exitCode: 0, lines: out, errLines };
  });
}

module.exports = { run };
