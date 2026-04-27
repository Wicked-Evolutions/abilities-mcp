'use strict';

const {
  OAuthClient,
  TokenManager,
  AUTH_STATUS,
  DEFAULT_SCOPE,
} = require('../../auth');
const { discover } = require('../../auth/discovery-client');
const { makeRef, parseRef } = require('../../auth/secret-store');
const { CliError, EXIT_USAGE, fromAuthError, withProgress } = require('../errors');
const { subscribeProgress } = require('../output');
const { readConfig, writeConfig } = require('../config-store');
const testCmd = require('./test');

/**
 * `upgrade-auth <site_id> [--confirm]` — migrate an App Password site to
 * OAuth without disturbing the App Password fallback.
 *
 * Implements the four-step sequence locked in Appendix F.5:
 *
 *   Step 1 — Pre-flight discovery. 404 → "Site does not have OAuth. Install
 *            abilities-mcp-adapter v1.5.0+ first."
 *   Step 2 — Dual-write: copy current apppassword credentials to
 *            apppassword_fallback, then run the OAuth flow. On success the
 *            site uses OAuth; the fallback remains.
 *   Step 3 — Validation: run `test <site_id>`. On success, "✓ OAuth working.
 *            App Password kept as fallback for now." On failure, revert.
 *   Step 4 — `--confirm`: remove apppassword_fallback and delete the legacy
 *            keychain entry.
 *
 * `upgrade-auth` without `--confirm` is idempotent (per F.5 prose) — running
 * it twice on the same site is safe.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const SECRET_SERVICE = 'abilities-mcp';

async function run(args, ctx) {
  const siteId = args._ && args._[0];
  if (!siteId) {
    throw new CliError('upgrade-auth requires a site_id argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp upgrade-auth <site_id> [--confirm]',
    });
  }
  const config = readConfig(ctx.configPath);
  const site = config.sites[siteId];
  if (!site) {
    throw new CliError(`upgrade-auth: unknown site_id "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp list-sites to see configured sites',
    });
  }

  // ---- Step 4: --confirm cleans up the fallback. -----------------------
  if (args.confirm) {
    return _confirm(siteId, site, config, ctx);
  }

  if (site.auth.method === 'oauth' && !site.auth.apppassword_fallback) {
    return {
      exitCode: 0,
      lines: [`Site "${siteId}" already uses OAuth with no App Password fallback.`,
              `(Idempotent — nothing to do.)`],
    };
  }

  if (site.auth.method !== 'apppassword') {
    // OAuth-with-fallback case is allowed (Step 2 may have already run).
    if (!(site.auth.method === 'oauth' && site.auth.apppassword_fallback)) {
      throw new CliError(
        `upgrade-auth: site "${siteId}" is not in a state we can upgrade (method=${site.auth.method})`,
        {
          exitCode: EXIT_USAGE,
          nextAction: `Run: abilities-mcp list-sites and inspect the site state`,
        }
      );
    }
  }

  const out = [];

  // ---- Step 1: pre-flight discovery. -----------------------------------
  out.push(`Step 1: pre-flight OAuth discovery for "${siteId}" (${site.url})…`);
  const discoverFn = (ctx.deps && ctx.deps.discover) || discover;
  try {
    await discoverFn(site.url, {
      pinned: !!site.oauth_capability_pinned,
      pinnedFirstSeenAt: site.oauth_capability_pinned && site.oauth_capability_pinned.first_seen_at,
      allowInsecure: ctx.allowInsecure,
    });
    out.push('  ✓ OAuth discovery succeeded.');
  } catch (err) {
    if (err && err.name === 'DiscoveryError') {
      throw new CliError(
        `Site ${siteId} does not have OAuth. Install abilities-mcp-adapter v1.5.0+ first.`,
        {
          exitCode: 4,
          nextAction: 'Install / upgrade abilities-mcp-adapter on the site to v1.5.0 or later',
          cause: err,
        }
      );
    }
    throw fromAuthError(err, { siteId });
  }

  // ---- Step 2: dual-write. ---------------------------------------------
  out.push(`Step 2: running OAuth flow while keeping App Password as fallback…`);

  // Stash the current apppassword credentials before the OAuth flow runs.
  // If the operator has already done step 2 (resuming after a partial run),
  // the fallback already exists and we leave it untouched.
  let pendingFallback = site.auth.apppassword_fallback || null;
  if (!pendingFallback && site.auth.method === 'apppassword') {
    pendingFallback = {
      username: site.auth.username,
      password_ref: site.auth.password_ref,
    };
    // Move the keychain entry from <siteId>/apppassword to
    // <siteId>/apppassword-legacy per the F.5 example. We do this before
    // the OAuth flow so a mid-flow crash leaves us with a recoverable
    // state (operator can re-run upgrade-auth).
    const legacyAccount = `${siteId}/apppassword-legacy`;
    try {
      const oldAccount = parseRef(site.auth.password_ref).account;
      const value = await ctx.secretStore.get(SECRET_SERVICE, oldAccount);
      if (typeof value === 'string') {
        await ctx.secretStore.set(SECRET_SERVICE, legacyAccount, value);
      }
    } catch {
      // Non-fatal — operator may have already deleted the original entry.
    }
    pendingFallback = {
      username: site.auth.username,
      password_ref: makeRef(SECRET_SERVICE, legacyAccount),
    };
  }

  const clientName = `${ctx.userLabel}'s Operator (${ctx.hostnameLabel})`;
  const OAuthClientCls = (ctx.deps && ctx.deps.OAuthClient) || OAuthClient;
  const oauth = new OAuthClientCls({
    siteUrl: site.url,
    clientName,
    softwareVersion: ctx.softwareVersion,
    scope: args.scope || DEFAULT_SCOPE,
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
  catch (err) {
    out.push('✗ OAuth flow failed — config left unchanged. App Password remains primary.');
    throw fromAuthError(err, { siteId });
  }

  const tm = new TokenManager({ secretStore: ctx.secretStore, allowInsecure: ctx.allowInsecure });
  const persisted = await tm.persistTokens({ siteId, tokens: result.tokens });

  site.auth = {
    method: 'oauth',
    client_id: result.clientId,
    user_login: pendingFallback ? pendingFallback.username : (ctx.userLabel || 'operator'),
    scopes: result.scopes,
    access_token_expires_at: persisted.accessTokenExpiresAt,
    refresh_token_expires_at: persisted.refreshTokenExpiresAt,
    access_token_ref: persisted.accessTokenRef,
    refresh_token_ref: persisted.refreshTokenRef,
    apppassword_fallback: pendingFallback,
  };
  site.auth_status = AUTH_STATUS.ACTIVE;
  site.oauth_capability_pinned = {
    first_seen_at: result.capabilityPin.firstSeenAt,
    last_confirmed_at: result.capabilityPin.lastConfirmedAt,
  };
  if (result.prMetadata && result.prMetadata.resource) {
    site.mcp_resource = result.prMetadata.resource;
  }
  await writeConfig(ctx.configPath, config);

  // ---- Step 3: validation via `test`. ----------------------------------
  out.push(`Step 3: validating OAuth bearer with a ping…`);
  let pingFailed = false;
  let pingError;
  try {
    const testResult = await testCmd.run({ _: [siteId] }, ctx);
    for (const line of testResult.lines) out.push(`  ${line}`);
  } catch (err) {
    pingFailed = true;
    pingError = err;
  }

  if (pingFailed) {
    // Spec wording (binding): "✗ OAuth test failed — reverting."
    out.push('✗ OAuth test failed — reverting.');
    if (pendingFallback) {
      site.auth = {
        method: 'apppassword',
        username: pendingFallback.username,
        password_ref: pendingFallback.password_ref,
      };
      site.auth_status = AUTH_STATUS.ACTIVE;
      delete site.mcp_resource;
      await writeConfig(ctx.configPath, config);
    }
    // Attach progress lines so the router prints "✗ OAuth test failed —
    // reverting." on stdout alongside the stderr error from the ping.
    throw withProgress(fromAuthError(pingError, { siteId }), out);
  }

  // Spec wording (binding):
  //   "✓ OAuth working. App Password kept as fallback for now."
  out.push('✓ OAuth working. App Password kept as fallback for now.');
  out.push(`  Run: abilities-mcp upgrade-auth ${siteId} --confirm  (when ready to remove the fallback)`);
  return { exitCode: 0, lines: out };
}

async function _confirm(siteId, site, config, ctx) {
  if (site.auth.method !== 'oauth') {
    throw new CliError(
      `upgrade-auth --confirm: site "${siteId}" is not OAuth (method=${site.auth.method})`,
      {
        exitCode: EXIT_USAGE,
        nextAction: `Run: abilities-mcp upgrade-auth ${siteId}  (without --confirm) first`,
      }
    );
  }
  if (!site.auth.apppassword_fallback) {
    return {
      exitCode: 0,
      lines: [`Site "${siteId}" has no App Password fallback to remove. (Idempotent — nothing to do.)`],
    };
  }
  // Delete the legacy keychain entry, then strip the fallback from config.
  let legacyAccount;
  try { legacyAccount = parseRef(site.auth.apppassword_fallback.password_ref).account; }
  catch { legacyAccount = null; }
  if (legacyAccount) {
    await ctx.secretStore.delete(SECRET_SERVICE, legacyAccount).catch(() => {});
  }
  delete site.auth.apppassword_fallback;
  await writeConfig(ctx.configPath, config);
  return {
    exitCode: 0,
    // Spec wording (binding):
    //   "✓ Migration complete. App Password removed. Site siteX now uses OAuth only."
    lines: [`✓ Migration complete. App Password removed. Site ${siteId} now uses OAuth only.`],
  };
}

module.exports = { run };
