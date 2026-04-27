'use strict';

const { TokenManager, AUTH_STATUS } = require('../../auth');
const { resolveRef, parseRef } = require('../../auth/secret-store');
const { discover } = require('../../auth/discovery-client');
const { CliError, EXIT_USAGE, fromAuthError } = require('../errors');
const { readConfig, writeConfig } = require('../config-store');

/**
 * `revoke <site_id>` — local + remote revocation.
 *
 * Per the sub-issue: "local keychain cleanup + remote /oauth/revoke call."
 *
 * Behavior:
 *   1. Resolve the site's revocation_endpoint by re-running discovery (the
 *      site config does not stash the AS metadata — we re-fetch).
 *   2. POST refresh_token to /oauth/revoke (if present), then access_token.
 *      RFC 7009: revoking refresh also revokes derived access tokens, but we
 *      send both for adapters that don't cascade.
 *   3. Delete the keychain entries for this site.
 *   4. Mark auth_status = "revoked" in wp-sites.json so list-sites surfaces it.
 *
 * Errors are tolerated where the spirit is "best effort":
 *   - 4xx on revoke is treated as success (server has a final say).
 *   - 5xx / network error stops the flow before we delete keychain so the
 *     operator can retry without losing the token.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

async function run(args, ctx) {
  const siteId = args._ && args._[0];
  if (!siteId) {
    throw new CliError('revoke requires a site_id argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp revoke <site_id>',
    });
  }
  const config = readConfig(ctx.configPath);
  const site = config.sites[siteId];
  if (!site) {
    throw new CliError(`revoke: unknown site_id "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp list-sites to see configured sites',
    });
  }
  if (site.auth.method !== 'oauth') {
    throw new CliError(`revoke: site "${siteId}" uses ${site.auth.method}, not OAuth`, {
      exitCode: EXIT_USAGE,
      nextAction: `App Password sites are revoked by deleting the password in WordPress; use clear-keychain ${siteId} to remove the local copy`,
    });
  }

  const out = [];
  out.push(`Revoking OAuth tokens for site "${siteId}"…`);

  // Re-discover to get the revocation_endpoint. Use the existing capability
  // pin so a 404 on a previously-OAuth site still fails loud.
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
  const revocationEndpoint = asMetadata && asMetadata.revocation_endpoint;
  if (!revocationEndpoint) {
    out.push('  (Adapter does not advertise revocation_endpoint — skipping remote revocation, deleting local keychain only.)');
  }

  const tm = new TokenManager({ secretStore: ctx.secretStore, allowInsecure: ctx.allowInsecure });
  if (revocationEndpoint) {
    // Revoke refresh first (cascades on a compliant adapter), then access.
    const tokenRefs = [
      { kind: 'refresh_token', ref: site.auth.refresh_token_ref },
      { kind: 'access_token', ref: site.auth.access_token_ref },
    ];
    for (const { kind, ref } of tokenRefs) {
      if (!ref) continue;
      let token;
      try { token = await resolveRef(ctx.secretStore, ref); }
      catch {
        out.push(`  (No ${kind} present in keychain — skipping.)`);
        continue;
      }
      try {
        const res = await tm.revoke({
          revocationEndpoint,
          token,
          clientId: site.auth.client_id,
          tokenTypeHint: kind,
        });
        out.push(`  Remote revocation (${kind}): HTTP ${res.statusCode}`);
      } catch (err) {
        // 5xx → bail before we delete keychain (operator can retry).
        throw fromAuthError(err, { siteId });
      }
    }
  }

  // Delete keychain entries. Per F.5, account names follow `<siteId>/<kind>`.
  const accounts = [];
  for (const ref of [site.auth.access_token_ref, site.auth.refresh_token_ref]) {
    if (!ref) continue;
    try { accounts.push(parseRef(ref).account); } catch { /* ignore malformed */ }
  }
  for (const account of accounts) {
    await ctx.secretStore.delete('abilities-mcp', account).catch(() => {});
  }

  // Mark auth_status revoked rather than deleting the site — so the operator
  // sees a record in list-sites and can choose to remove it later.
  site.auth_status = AUTH_STATUS.REVOKED;
  await writeConfig(ctx.configPath, config);

  out.push(`✓ Site "${siteId}" revoked. Tokens deleted from keychain; auth_status = revoked.`);
  out.push(`  Run: abilities-mcp reauth ${siteId} to start a fresh authorization.`);
  return { exitCode: 0, lines: out };
}

module.exports = { run };
