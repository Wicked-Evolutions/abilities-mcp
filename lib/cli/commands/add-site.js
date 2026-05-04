'use strict';

const { URL } = require('node:url');

const {
  OAuthClient,
  TokenManager,
  AUTH_STATUS,
  DEFAULT_SCOPE,
} = require('../../auth');
const { makeRef } = require('../../auth/secret-store');
const { CliError, EXIT_USAGE, EXIT_CONFIG, fromAuthError } = require('../errors');
const { subscribeProgress } = require('../output');
const { readConfig, writeConfig, freshConfig } = require('../config-store');
const { probeMultisite: defaultProbeMultisite } = require('../multisite-probe');

/**
 * `add-site <url>` — register a new site with the bridge using OAuth (default)
 * or App Password (`--apppassword`).
 *
 * 1:1 mapping:
 *   - OAuth path  → new OAuthClient(...).run() → TokenManager.persistTokens(...)
 *   - apppassword → ctx.secretStore.set(<service>, <siteId>/apppassword, <pw>)
 *
 * Spec references:
 *   - "CLI surface" main spec section
 *   - I.5 (default scope, --scope override)
 *   - I.6 (config schema v1 source — handled in migration, not here)
 *   - F.5 (v2 site shape)
 *
 * Site-id derivation (CLI gap-fill — not in spec): hostname with the leading
 * www. stripped and the TLD removed. Operators can override with --site-id=ID.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const SECRET_SERVICE = 'abilities-mcp';

function deriveSiteId(siteUrl) {
  let host;
  try { host = new URL(siteUrl).hostname; }
  catch { return null; }
  const trimmed = host.replace(/^www\./, '');
  const dot = trimmed.indexOf('.');
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

/**
 * @param {object} args
 * @param {string[]} args._                positional args (first should be URL)
 * @param {boolean} [args.apppassword]
 * @param {string}  [args.username]        for --apppassword
 * @param {string}  [args.password]        for --apppassword
 * @param {string}  [args.scope]
 * @param {string}  [args['site-id']]
 * @param {boolean} [args.force]           overwrite existing site of same id
 * @param {object} ctx
 * @returns {Promise<{exitCode:number, lines:string[]}>}
 */
async function run(args, ctx) {
  const url = args._ && args._[0];
  if (typeof url !== 'string' || url.length === 0) {
    throw new CliError('add-site requires a site URL argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp add-site <url> [--apppassword]',
    });
  }
  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch (err) {
    throw new CliError(`add-site: invalid URL: ${url}`, {
      exitCode: EXIT_USAGE,
      nextAction: 'Provide a full https://... URL',
      cause: err,
    });
  }
  if (parsedUrl.protocol !== 'https:' && !ctx.allowInsecure) {
    throw new CliError(`add-site: HTTPS required (got ${parsedUrl.protocol})`, {
      exitCode: EXIT_USAGE,
      nextAction: 'Provide an https:// URL or pass --allow-insecure for localhost dev',
    });
  }

  const explicitId = args['site-id'];
  const siteId = explicitId || deriveSiteId(url);
  if (!siteId) {
    throw new CliError('add-site: cannot derive a site_id from the URL', {
      exitCode: EXIT_USAGE,
      nextAction: 'Pass --site-id=<id> explicitly',
    });
  }

  // Load (or create) the config and check for collisions.
  let config;
  try { config = readConfig(ctx.configPath); }
  catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_CONFIG && /not found/i.test(err.message)) {
      config = freshConfig();
    } else {
      throw err;
    }
  }
  if (config.sites[siteId] && !args.force) {
    throw new CliError(`add-site: site_id "${siteId}" already exists in ${ctx.configPath}`, {
      exitCode: EXIT_USAGE,
      nextAction: `Run: abilities-mcp reauth ${siteId} (or pass --force / --site-id=<other> to overwrite)`,
    });
  }

  const out = [];
  const errLines = [];
  let exitCode = 0;

  if (args.apppassword) {
    if (!args.username) {
      throw new CliError('add-site --apppassword requires --username=<wp_user>', {
        exitCode: EXIT_USAGE,
        nextAction: 'Run: abilities-mcp add-site <url> --apppassword --username=<u> --password=<p>',
      });
    }
    if (!args.password) {
      throw new CliError('add-site --apppassword requires --password=<application_password>', {
        exitCode: EXIT_USAGE,
        nextAction: 'Generate an Application Password in WP admin → Users → Profile and pass it via --password',
      });
    }
    const account = `${siteId}/apppassword`;
    await ctx.secretStore.set(SECRET_SERVICE, account, args.password);
    config.sites[siteId] = {
      url: parsedUrl.origin,
      label: args.label || parsedUrl.hostname,
      auth: {
        method: 'apppassword',
        username: args.username,
        password_ref: makeRef(SECRET_SERVICE, account),
      },
      auth_status: AUTH_STATUS.ACTIVE,
    };
    if (!config.defaultSite) config.defaultSite = siteId;
    await writeConfig(ctx.configPath, config);
    out.push(`✓ Site "${siteId}" configured with App Password authentication.`);
    out.push(`  Config: ${ctx.configPath}`);
    return { exitCode, lines: out, errLines };
  }

  // OAuth path — full authorization-code + PKCE flow via OAuthClient.
  const clientName = `${ctx.userLabel}'s Operator (${ctx.hostnameLabel})`;
  const oauth = (ctx.deps && ctx.deps.OAuthClient)
    ? new ctx.deps.OAuthClient({
        siteUrl: parsedUrl.origin,
        clientName,
        softwareVersion: ctx.softwareVersion,
        scope: args.scope || DEFAULT_SCOPE,
        identityProvider: ctx.identityProvider,
        allowInsecure: ctx.allowInsecure,
        deps: ctx.deps && ctx.deps.oauthClientDeps,
      })
    : new OAuthClient({
        siteUrl: parsedUrl.origin,
        clientName,
        softwareVersion: ctx.softwareVersion,
        scope: args.scope || DEFAULT_SCOPE,
        identityProvider: ctx.identityProvider,
        allowInsecure: ctx.allowInsecure,
        deps: ctx.deps && ctx.deps.oauthClientDeps,
      });

  out.push(`Adding site "${siteId}" (${parsedUrl.origin}) via OAuth…`);
  subscribeProgress(oauth, out);

  let result;
  try { result = await oauth.run(); }
  catch (err) { throw fromAuthError(err, { siteId }); }

  // Persist tokens to keychain via TokenManager, then write the v2 site.
  const tm = new TokenManager({ secretStore: ctx.secretStore, allowInsecure: ctx.allowInsecure });
  const persisted = await tm.persistTokens({ siteId, tokens: result.tokens });

  config.sites[siteId] = {
    url: parsedUrl.origin,
    label: args.label || parsedUrl.hostname,
    auth: {
      method: 'oauth',
      client_id: result.clientId,
      user_login: _userLoginFromTokens(result, ctx),
      scopes: result.scopes,
      access_token_expires_at: persisted.accessTokenExpiresAt,
      refresh_token_expires_at: persisted.refreshTokenExpiresAt,
      access_token_ref: persisted.accessTokenRef,
      refresh_token_ref: persisted.refreshTokenRef,
    },
    auth_status: AUTH_STATUS.ACTIVE,
    oauth_capability_pinned: {
      first_seen_at: result.capabilityPin.firstSeenAt,
      last_confirmed_at: result.capabilityPin.lastConfirmedAt,
    },
  };
  // Adapter-derived MCP endpoint for runtime HTTP calls. Stored alongside
  // OAuth state so the existing transport layer keeps working.
  if (result.prMetadata && result.prMetadata.resource) {
    config.sites[siteId].mcp_resource = result.prMetadata.resource;
  }

  // Multisite Network root probe. If the freshly authenticated bridge can
  // resolve `multisite/list-sites`, populate the multisite block so dot-
  // notation routing works without operator JSON editing. Single-site,
  // permission-denied, and network errors all degrade gracefully — the
  // site entry is still written without a multisite block.
  const probeEndpoint = result.prMetadata && result.prMetadata.resource;
  if (probeEndpoint && result.tokens && result.tokens.access_token) {
    const probe = (ctx.deps && ctx.deps.probeMultisite) || defaultProbeMultisite;
    try {
      const probeResult = await probe({
        endpoint: probeEndpoint,
        accessToken: result.tokens.access_token,
        siteUrl: parsedUrl.origin,
        log: typeof ctx.log === 'function' ? ctx.log : null,
        deps: ctx.deps && ctx.deps.probeMultisiteDeps,
      });
      if (probeResult && probeResult.block && Object.keys(probeResult.block).length > 0) {
        config.sites[siteId].multisite = probeResult.block;
        const slugs = Object.keys(probeResult.block).join(', ');
        out.push(`  Multisite: discovered ${Object.keys(probeResult.block).length} subsite(s) → ${slugs}`);
      }
    } catch (probeErr) {
      _appendProbeAdvisory(probeErr, siteId, errLines);
    }
  }

  if (!config.defaultSite) config.defaultSite = siteId;
  await writeConfig(ctx.configPath, config);

  out.push(`✓ Site "${siteId}" configured. Granted scopes: ${result.scopes.join(', ')}.`);
  out.push(`  Config: ${ctx.configPath}`);
  return { exitCode, lines: out, errLines };
}

/**
 * Append a stderr advisory naming the multisite-probe failure so operators
 * who expected dot-notation routing know why it isn't wired and can either
 * fix the underlying issue or hand-add the block per existing docs.
 *
 * Silent for `tool_not_registered` (single-site is the expected case for
 * the vast majority of `add-site` invocations).
 */
function _appendProbeAdvisory(probeErr, siteId, errLines) {
  const code = probeErr && probeErr.code;
  if (code === 'tool_not_registered') return;

  if (code === 'permission_denied' || code === 'unauthorized') {
    errLines.push(
      `Multisite discovery skipped for "${siteId}": multisite/list-sites was rejected ` +
      `by the adapter. Two possible causes — verify both before manually adding the block: ` +
      `(1) the OAuth user lacks the manage_network_options WP capability (super-admin ` +
      `required on a Multisite Network root), or (2) the OAuth token lacks the ` +
      `abilities:multisite:read scope (it must be granted on the consent screen — ` +
      `re-run add-site and confirm the multisite scope checkbox if it was unchecked). ` +
      `Site entry written without multisite block — dot-notation subsite routing ` +
      `will not be available until the block is added manually or add-site is re-run.`
    );
    return;
  }

  const detail = (probeErr && probeErr.message) || String(probeErr);
  errLines.push(
    `Multisite discovery failed for "${siteId}": ${detail}. ` +
    `Site entry written without multisite block — dot-notation subsite routing ` +
    `will not be available until the block is added manually or add-site is re-run.`
  );
}

/**
 * Best-effort user_login extraction. The token endpoint may include the
 * username in a non-standard claim; if absent we fall back to the OS user as
 * a placeholder operators can edit. The runtime does not depend on this
 * value — it is display-only per F.5.
 */
function _userLoginFromTokens(result, ctx) {
  if (result.tokens && typeof result.tokens.user_login === 'string') {
    return result.tokens.user_login;
  }
  if (result.tokens && typeof result.tokens.username === 'string') {
    return result.tokens.username;
  }
  return ctx.userLabel || 'operator';
}

module.exports = { run, deriveSiteId };
