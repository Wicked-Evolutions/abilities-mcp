'use strict';

const { CliError, EXIT_USAGE } = require('../errors');

/**
 * `clear-keychain <site_id>` — remove orphaned keychain entries (H.3.2).
 *
 * Per Appendix H.3.2 (binding for v1.0):
 *
 *   "v1.0 does not persist bridge identity. Each install gets a fresh
 *    `client_id` per site, so you'll re-authorize each site once. If you
 *    wipe `wp-sites.json` manually, no cleanup is needed — there is no
 *    orphan state."
 *
 * H.3.2 is talking specifically about the `client_id` keychain entry, which
 * v1.0 deliberately does not write. But the bridge DOES persist three other
 * kinds of keychain material per F.5:
 *   <siteId>/access
 *   <siteId>/refresh
 *   <siteId>/apppassword | <siteId>/apppassword-legacy
 *
 * If an operator wipes their wp-sites.json by hand, those three entries
 * become orphaned. `clear-keychain <site_id>` is the deterministic way to
 * clean them up without manually using the OS keychain UI.
 *
 * Behavior:
 *   - Lists all entries under the `abilities-mcp` service via findAll().
 *   - Deletes any entry whose account begins with `<site_id>/`.
 *   - Reports how many entries were removed.
 *
 * Does NOT touch wp-sites.json — `revoke` is the right command if the site
 * still exists in config and you want both keychain + remote revocation.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const SECRET_SERVICE = 'abilities-mcp';

async function run(args, ctx) {
  const siteId = args._ && args._[0];
  if (!siteId) {
    throw new CliError('clear-keychain requires a site_id argument', {
      exitCode: EXIT_USAGE,
      nextAction: 'Run: abilities-mcp clear-keychain <site_id>',
    });
  }
  // The siteId argument MUST be a single segment — refuse "../" or "/" so
  // we never accidentally widen the prefix match.
  if (siteId.includes('/') || siteId.includes('..')) {
    throw new CliError(`clear-keychain: invalid site_id "${siteId}"`, {
      exitCode: EXIT_USAGE,
      nextAction: 'site_id must be a single keychain-account segment (no "/" or "..")',
    });
  }
  const prefix = `${siteId}/`;
  const all = await ctx.secretStore.findAll(SECRET_SERVICE);
  const matched = all.filter((entry) => entry.account.startsWith(prefix));
  for (const entry of matched) {
    await ctx.secretStore.delete(SECRET_SERVICE, entry.account);
  }
  const lines = matched.length > 0
    ? [
        `✓ Removed ${matched.length} keychain ${matched.length === 1 ? 'entry' : 'entries'} for "${siteId}":`,
        ...matched.map((e) => `  - ${e.account}`),
      ]
    : [`No keychain entries found for "${siteId}". (Idempotent — nothing to do.)`];
  return { exitCode: 0, lines };
}

module.exports = { run };