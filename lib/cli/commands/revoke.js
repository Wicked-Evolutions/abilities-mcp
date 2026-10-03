'use strict';

const { TokenManager, CredentialCoordinator, AUTH_STATUS } = require('../../auth');
const { resolveRef, parseRef } = require('../../auth/secret-store');
const { discover } = require('../../auth/discovery-client');
const { CliError, EXIT_USAGE, fromAuthError } = require('../errors');
const { readConfig, mutateConfig, mutateSiteConfig, siteCredentialVersion } = require('../config-store');

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
  const expectedCredential = siteCredentialVersion(site);

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

  const coordinator = new CredentialCoordinator({ secretStore: ctx.secretStore, configPath: ctx.configPath, siteId,
    deps: { stateRoot: ctx.deps && ctx.deps.oauthCoordinationStateRoot } });
  const tm = new TokenManager({ secretStore: ctx.secretStore, allowInsecure: ctx.allowInsecure });
  const revokeCurrent = async () => {
  // Claim before any effect. A second config referring to the same
  // credential identity fails here rather than revoking another site's pair.
  if (expectedCredential && expectedCredential.identity) {
    await coordinator.claimOwnership(expectedCredential.identity, siteId);
  }
  const currentSite = await mutateConfig(ctx.configPath, 'cli-revoke-read-current', (currentConfig) => {
    const current = currentConfig.sites && currentConfig.sites[siteId];
    if (!current) throw new CliError(`revoke: site "${siteId}" no longer exists`, { exitCode: EXIT_USAGE });
    if (expectedCredential) {
      const actual = siteCredentialVersion(current);
      if (JSON.stringify(actual) !== JSON.stringify(expectedCredential)) {
        throw new CliError(`revoke: credentials for "${siteId}" changed before revocation`, {
          exitCode: EXIT_USAGE, nextAction: `Re-run revoke for "${siteId}".`,
        });
      }
    }
    return { write: false, value: current };
  });
  const currentAuth = currentSite.auth;
  let pair = null;
  if (currentAuth.credential_pair_ref) {
    try {
      pair = await coordinator.readPair({
        credential_pair_ref: currentAuth.credential_pair_ref,
        credential_generation: currentAuth.credential_generation,
      });
    } catch {
      out.push('  (Committed credential pair is unavailable — skipping remote token revocation.)');
    }
  }
  if (revocationEndpoint) {
    // Revoke refresh first (cascades on a compliant adapter), then access.
    const tokenRefs = pair
      ? [{ kind: 'refresh_token', token: pair.refresh_token }, { kind: 'access_token', token: pair.access_token }]
      : [{ kind: 'refresh_token', ref: currentAuth.refresh_token_ref }, { kind: 'access_token', ref: currentAuth.access_token_ref }];
    for (const item of tokenRefs) {
      const { kind } = item;
      if (!item.ref && !item.token) continue;
      let token = item.token;
      if (!token) {
        try { token = await resolveRef(ctx.secretStore, item.ref); }
        catch {
          out.push(`  (No ${kind} present in keychain — skipping.)`);
          continue;
        }
      }
      try {
        const res = await tm.revoke({
          revocationEndpoint,
          token,
          clientId: currentAuth.client_id,
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
  for (const ref of [currentAuth.access_token_ref, currentAuth.refresh_token_ref]) {
    if (!ref) continue;
    try { accounts.push(parseRef(ref).account); } catch { /* ignore malformed */ }
  }
  // Pair storage is a bounded two-slot ring. Never enumerate all keychain
  // items; explicit known slots preserve the keychain's nonblocking scope.
  if (currentAuth.credential_identity) {
    accounts.push(
      `${currentAuth.credential_identity}/credential-pair/a`,
      `${currentAuth.credential_identity}/credential-pair/b`
    );
  }
  const commitRevocation = async () => {
    // Mark auth_status revoked rather than deleting the site — so the
    // operator sees a record in list-sites and can choose to remove it later.
    // The fence prevents a remote-revocation wait from marking a newer
    // authorization revoked.
    await mutateSiteConfig(ctx.configPath, 'cli-revoke', siteId, (currentConfig, current) => {
      if (!current || current.auth.method !== 'oauth') {
        throw new CliError(`revoke: site "${siteId}" changed while revocation was running`, {
          exitCode: EXIT_USAGE,
          nextAction: `Inspect "${siteId}" before attempting revocation again.`,
        });
      }
      current.auth_status = AUTH_STATUS.REVOKED;
    }, { expectedCredential: siteCredentialVersion(currentSite) });
    for (const account of accounts) {
      await ctx.secretStore.delete('abilities-mcp', account).catch(() => {});
    }
  };
  // Runtime refresh obtains this lock before its config commit. Holding it
  // here keeps a same-identity rotation from publishing a new pair while the
  // explicit revoke removes the bounded pair slots.
  await commitRevocation();
  };
  if (expectedCredential && expectedCredential.identity) {
    await coordinator.withCredentialLock(expectedCredential.identity, 'cli-revoke', revokeCurrent);
  } else {
    await revokeCurrent();
  }

  out.push(`✓ Site "${siteId}" revoked. Tokens deleted from keychain; auth_status = revoked.`);
  out.push(`  Run: abilities-mcp reauth ${siteId} to start a fresh authorization.`);
  return { exitCode: 0, lines: out };
}

module.exports = { run };
