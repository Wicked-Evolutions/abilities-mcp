'use strict';

/**
 * Output formatter for CLI subcommands.
 *
 * Returns lines (strings) rather than printing directly so commands stay
 * testable without stdout capture. The router writes `lines` to stdout, and
 * any `errLines` to stderr, after the command resolves.
 *
 * Renders:
 *   - State-machine progress lines (subscribed from lib/auth/ events).
 *   - Site tables for `list-sites`.
 *   - "next action" hints for failed commands.
 *
 * No emoji unless the spec verbatim text uses one (✓, ✗, ⚠ appear in the
 * design doc's binding error wording — those we preserve).
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const { STATES } = require('../auth/events');

const PROGRESS_LABEL = Object.freeze({
  [STATES.DISCOVERING]:        '→ Discovering OAuth metadata',
  [STATES.REGISTERING]:        '→ Registering bridge client (DCR)',
  [STATES.AWAITING_CONSENT]:   '→ Waiting for consent in browser',
  [STATES.EXCHANGING]:         '→ Exchanging authorization code for tokens',
  [STATES.COMPLETE]:           '✓ Authorization complete',
  [STATES.FAILED]:             '✗ Authorization failed',
});

/**
 * Subscribe to an OAuthClient event emitter and push human-readable progress
 * lines onto `out`. The caller decides when to flush; this only mutates `out`.
 *
 * @param {import('node:events').EventEmitter} client
 * @param {string[]} out
 * @param {object} [opts]
 * @param {boolean} [opts.includeProgress]   default true — sub-step lines
 * @param {boolean} [opts.includeAuthorizeUrl] default true — print URL when
 *                                              awaiting_consent so headless
 *                                              operators can paste it.
 */
function subscribeProgress(client, out, opts = {}) {
  const includeProgress = opts.includeProgress !== false;
  const includeAuthorizeUrl = opts.includeAuthorizeUrl !== false;
  client.on('state', ({ to, data }) => {
    const label = PROGRESS_LABEL[to];
    if (label) out.push(label);
    if (includeAuthorizeUrl && to === STATES.AWAITING_CONSENT && data && data.authorizeUrl) {
      out.push(`  If a browser tab does not open, paste this URL:`);
      out.push(`  ${data.authorizeUrl}`);
    }
  });
  if (includeProgress) {
    client.on('progress', ({ message, data }) => {
      // Pull a couple of useful fields out for the operator without dumping
      // raw JSON. Keep it terse.
      if (message === 'discovery_succeeded' && data && data.asMetadataUrl) {
        out.push(`  Authorization server: ${data.asMetadataUrl}`);
      } else if (message === 'registered' && data && data.clientId) {
        out.push(`  Registered client: ${data.clientId}`);
      } else if (message === 'callback_received') {
        out.push('  Consent received from browser');
      } else if (message === 'browser_launch_failed') {
        out.push('  (Browser launch failed — paste the URL above into your browser)');
      } else if (message === 'reusing_persisted_client_id' && data && data.clientId) {
        out.push(`  Reusing persisted client_id: ${data.clientId}`);
      }
    });
  }
}

/**
 * Render a list of `sites` per F.5 example:
 *
 *   SITE        URL                          AUTH        USER         SCOPES                EXPIRES
 *   siteA       https://siteA.com            oauth       wp_agent     read, write, menus    in 87 days
 *
 * @param {Array<{
 *   siteId: string,
 *   url: string,
 *   authMethod: string,
 *   user: string,
 *   scopesShort: string,
 *   expires: string,
 *   statusBadge: string,
 *   downgradeAnnotation: string,
 * }>} rows
 * @param {object} [opts]
 * @param {number} [opts.maxWidth]    Default 120 — wraps wide tables to fit.
 * @returns {string[]} lines
 */
function renderSiteTable(rows, opts = {}) {
  if (!rows.length) {
    return ['(no sites configured — run: abilities-mcp add-site <url>)'];
  }
  const headers = ['SITE', 'URL', 'AUTH', 'USER', 'SCOPES', 'EXPIRES', 'STATUS'];
  const widths = headers.map((h) => h.length);
  for (const r of rows) {
    widths[0] = Math.max(widths[0], r.siteId.length);
    widths[1] = Math.max(widths[1], r.url.length);
    widths[2] = Math.max(widths[2], r.authMethod.length);
    widths[3] = Math.max(widths[3], r.user.length);
    widths[4] = Math.max(widths[4], r.scopesShort.length);
    widths[5] = Math.max(widths[5], r.expires.length);
    widths[6] = Math.max(widths[6], r.statusBadge.length);
  }
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  const lines = [];
  lines.push(fmt(headers));
  for (const r of rows) {
    lines.push(fmt([
      r.siteId, r.url, r.authMethod, r.user, r.scopesShort, r.expires, r.statusBadge,
    ]));
    if (r.refreshExpiresAnnotation) {
      lines.push(`  ${r.refreshExpiresAnnotation}`);
    }
    if (r.downgradeAnnotation) {
      lines.push(`  ${r.downgradeAnnotation}`);
    }
  }
  return lines;
}

/**
 * Compute a human "in N days" / "expired" string from an ISO timestamp.
 * @param {string|null|undefined} iso
 * @param {number} [nowMs]
 * @returns {string}
 */
function expiresLabel(iso, nowMs) {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const days = Math.floor((at - now) / (24 * 3600 * 1000));
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return 'today';
  if (days === 1) return 'in 1 day';
  return `in ${days} days`;
}

/**
 * Compact rendering of a scope list for the EXPIRES table.
 * Drops the `abilities:` prefix and joins with commas. Truncates to 4 entries
 * with a "+N" suffix to keep the table readable.
 *
 * @param {string[]} scopes
 * @returns {string}
 */
function shortScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return '(full)';
  const trimmed = scopes.map((s) => s.replace(/^abilities:/, ''));
  if (trimmed.length <= 4) return trimmed.join(', ');
  return trimmed.slice(0, 3).join(', ') + ` +${trimmed.length - 3}`;
}

/**
 * Render the trailing "next action" hint for a failed CliError.
 * @param {import('./errors').CliError} err
 * @returns {string[]}
 */
function renderNextAction(err) {
  const lines = [`✗ ${err.message}`];
  if (err.nextAction) lines.push(`  → ${err.nextAction}`);
  return lines;
}

module.exports = {
  subscribeProgress,
  renderSiteTable,
  renderNextAction,
  expiresLabel,
  shortScopes,
  PROGRESS_LABEL,
};
