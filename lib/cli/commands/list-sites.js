'use strict';

const { AUTH_STATUS } = require('../../auth');
const { readConfig } = require('../config-store');
const { renderSiteTable, expiresLabel, shortScopes } = require('../output');
const { CliError, EXIT_CONFIG } = require('../errors');

/**
 * `list-sites` — print a table of all sites + auth status.
 *
 * Columns chosen to match the F.5 example output:
 *   SITE   URL   AUTH   USER   SCOPES   EXPIRES
 * Phase 5 adds a STATUS column (active / expired / revoked / pending-reauth)
 * because F.5 mandates the enum but the example didn't show it.
 *
 * H.2.3 mandates that `force-downgrade` actions are surfaced in `list-sites`
 * for 30 days. We render an annotation line under the affected site row.
 *
 * Spec references:
 *   - "CLI surface" main spec section (column choice)
 *   - F.5 (auth_status enum + apppassword fallback presence)
 *   - I.3 (status labels)
 *   - H.2.3 (force-downgrade audit surfacing)
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const STATUS_BADGE = Object.freeze({
  [AUTH_STATUS.ACTIVE]: 'active',
  [AUTH_STATUS.EXPIRED]: 'expired',
  [AUTH_STATUS.REVOKED]: 'revoked',
  [AUTH_STATUS.PENDING_REAUTH]: 'pending-reauth',
});

async function run(args, ctx) {
  let config;
  try { config = readConfig(ctx.configPath); }
  catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_CONFIG && /not found/i.test(err.message)) {
      return {
        exitCode: 0,
        lines: [
          '(no sites configured — run: abilities-mcp add-site <url>)',
        ],
      };
    }
    throw err;
  }

  const nowMs = ctx.now ? ctx.now() : Date.now();
  const rows = [];
  for (const [siteId, site] of Object.entries(config.sites)) {
    const auth = site.auth;
    const isOAuth = auth.method === 'oauth';
    const user = isOAuth ? (auth.user_login || '—') : (auth.username || '—');
    const scopesShort = isOAuth ? shortScopes(auth.scopes) : '(full)';
    const expires = isOAuth ? expiresLabel(auth.access_token_expires_at, nowMs) : '—';

    let statusBadge = STATUS_BADGE[site.auth_status] || site.auth_status || '?';
    // Decorate the badge with the apppassword-fallback signal — operators
    // mid-upgrade will want to see it.
    if (isOAuth && auth.apppassword_fallback) {
      statusBadge += ' +apppassword-fallback';
    }

    // Issue #89: surface the ACTUAL refresh-token expiry so the discrepancy
    // between a (possibly stale) cached status badge and the underlying
    // refresh-token validity is operator-visible and self-recoverable. The
    // EXPIRES column is the access token; this annotation is the refresh
    // token (the 90-day "authorize once" window).
    let refreshExpiresAnnotation = null;
    if (isOAuth && auth.refresh_token_expires_at) {
      refreshExpiresAnnotation =
        `refresh token: valid until ${auth.refresh_token_expires_at} ` +
        `(${expiresLabel(auth.refresh_token_expires_at, nowMs)})`;
    }

    let downgradeAnnotation = null;
    if (site.force_downgrade) {
      const expiresAt = Date.parse(site.force_downgrade.expires_at);
      if (!Number.isNaN(expiresAt) && expiresAt > nowMs) {
        const at = Date.parse(site.force_downgrade.at);
        const days = Number.isNaN(at) ? '?' : Math.max(0, Math.floor((nowMs - at) / (24 * 3600 * 1000)));
        downgradeAnnotation = `⚠ force-downgrade ${days}d ago${site.force_downgrade.reason ? ` (${site.force_downgrade.reason})` : ''}`;
      }
    }

    rows.push({
      siteId,
      url: site.url || '—',
      authMethod: auth.method,
      user,
      scopesShort,
      expires,
      statusBadge,
      refreshExpiresAnnotation,
      downgradeAnnotation,
    });
  }

  const lines = renderSiteTable(rows);
  return { exitCode: 0, lines };
}

module.exports = { run };
