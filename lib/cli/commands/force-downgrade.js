'use strict';

const { CliError, EXIT_USAGE } = require('../errors');
const { readConfig, writeConfig } = require('../config-store');

/**
 * `force-downgrade <site_id> --i-understand-the-risk` — override OAuth
 * capability pinning (Appendix H.2.3).
 *
 * H.2.3 states force-downgrade is "a deliberate, audit-logged action" and that
 * the action is "surfaced in `list-sites` output for the next 30 days." The
 * spec leaves the audit-log schema to the implementer.
 *
 * Phase 5 design choice: store the audit record on the site itself rather
 * than in a separate log file. The record has three fields:
 *   force_downgrade.at           ISO 8601, when the operator ran the command
 *   force_downgrade.expires_at   at + 30 days (ISO)
 *   force_downgrade.reason       free-form string from --reason=<...>
 *
 * `list-sites` reads `force_downgrade.expires_at` and surfaces an annotation
 * line under the affected site row until expiry. A separate log file would
 * be redundant — the site config already lives in version-control-friendly
 * JSON, which is the most accessible audit surface on a developer's laptop.
 *
 * Effect on runtime: clears `oauth_capability_pinned` so subsequent discovery
 * misses no longer raise `CapabilityPinningError`. The site config keeps its
 * OAuth `auth.method` so the operator can return to OAuth simply by running
 * `add-site` or `reauth` (which re-pin on success).
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const AUDIT_RETENTION_DAYS = 30;

async function run(args, ctx) {
  const siteId = args._ && args._[0];
  if (!siteId) {
    throw new CliError('force-downgrade requires a site_id argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp force-downgrade <site_id> --i-understand-the-risk',
    });
  }
  if (!args['i-understand-the-risk']) {
    throw new CliError(
      'force-downgrade requires --i-understand-the-risk (Appendix H.2.3 — deliberate override)',
      {
        exitCode: EXIT_USAGE,
        nextAction: 'Re-run with --i-understand-the-risk if you have verified the site genuinely no longer supports OAuth',
      }
    );
  }
  const config = readConfig(ctx.configPath);
  const site = config.sites[siteId];
  if (!site) {
    throw new CliError(`force-downgrade: unknown site_id "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp list-sites to see configured sites',
    });
  }
  if (!site.oauth_capability_pinned) {
    return {
      exitCode: 0,
      lines: [
        `Site "${siteId}" is not OAuth-pinned — nothing to override.`,
        `(Idempotent — no audit record written.)`,
      ],
    };
  }

  const nowMs = ctx.now ? ctx.now() : Date.now();
  const at = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + AUDIT_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const reason = typeof args.reason === 'string' && args.reason.length > 0
    ? args.reason
    : 'no reason given';

  delete site.oauth_capability_pinned;
  site.force_downgrade = { at, expires_at: expiresAt, reason };
  await writeConfig(ctx.configPath, config);

  return {
    exitCode: 0,
    lines: [
      `⚠ force-downgrade recorded for site "${siteId}".`,
      `  Reason: ${reason}`,
      `  Audit record expires: ${expiresAt} (visible in list-sites for ${AUDIT_RETENTION_DAYS} days).`,
      `  OAuth capability pin cleared — silent App Password fallback is now allowed for this site.`,
    ],
  };
}

module.exports = { run, AUDIT_RETENTION_DAYS };
