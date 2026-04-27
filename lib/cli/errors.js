'use strict';

/**
 * CLI error helpers + exit-code table.
 *
 * The design doc does not pin a CLI exit-code table — only the constraint that
 * `lib/auth/` itself contains no `process.exit` calls. The table below is a
 * Phase 5 design choice, intentionally narrow:
 *
 *   0  success
 *   1  generic / unexpected error                (catch-all, includes --debug stack)
 *   2  usage error                               (bad args, unknown subcommand)
 *   3  config error                              (wp-sites.json missing/invalid)
 *   4  auth failure                              (consent denied, refresh expired,
 *                                                 token endpoint 4xx, network)
 *   5  capability-pinning violation              (H.2.3 — pinned site lost OAuth)
 *
 * Operator-facing error messages MUST name the next action to take. CliError
 * carries that next-action text on the `nextAction` field so the formatter can
 * render it consistently.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const EXIT_OK = 0;
const EXIT_GENERIC = 1;
const EXIT_USAGE = 2;
const EXIT_CONFIG = 3;
const EXIT_AUTH = 4;
const EXIT_PIN_VIOLATION = 5;

class CliError extends Error {
  /**
   * @param {string} message            One-line operator-facing summary.
   * @param {object} [opts]
   * @param {number} [opts.exitCode]    Defaults to EXIT_GENERIC.
   * @param {string} [opts.nextAction]  Required for non-zero exits — names the
   *                                    exact command / action the operator
   *                                    should run next.
   * @param {Error}  [opts.cause]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : EXIT_GENERIC;
    this.nextAction = opts.nextAction || null;
    // Progress lines accumulated by the command before it threw — these are
    // the operator's record of "how far the command got." The router prints
    // them on stdout so the operator sees the partial trace alongside the
    // error on stderr. (The lib/auth/ state machine has no notion of CLI
    // output, so commands accumulate lines locally and pass them along.)
    if (Array.isArray(opts.progressLines)) this.progressLines = opts.progressLines;
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * Map a thrown error from `lib/auth/` (or anywhere) onto a CliError.
 * Pure — does not print. The caller decides how to render.
 *
 * @param {Error} err
 * @param {object} [ctx]                Optional context to enrich next-action
 * @param {string} [ctx.siteId]
 * @returns {CliError}
 */
function fromAuthError(err, ctx = {}) {
  if (err instanceof CliError) {
    // Caller may layer additional progressLines onto an already-CliError.
    if (Array.isArray(ctx.progressLines) && !err.progressLines) {
      err.progressLines = ctx.progressLines;
    }
    return err;
  }

  const code = err && err.code;
  const siteRef = ctx.siteId || (err && err.reauthHint && err.reauthHint.siteId) || null;
  const progressLines = Array.isArray(ctx.progressLines) ? ctx.progressLines : undefined;

  // H.2.3 — capability pinning failure has its own exit code so scripts can
  // distinguish a possible network-attack signal from a routine auth failure.
  if (err && err.name === 'CapabilityPinningError') {
    return new CliError(err.message, {
      exitCode: EXIT_PIN_VIOLATION,
      nextAction: siteRef
        ? `Run: abilities-mcp force-downgrade ${siteRef} --i-understand-the-risk (only if you intend to override OAuth pinning)`
        : 'Run: abilities-mcp force-downgrade <site_id> --i-understand-the-risk (only if you intend to override OAuth pinning)',
      cause: err,
    });
  }

  // Operator denied consent on the adapter screen — no remediation needed
  // beyond re-running add-site / reauth.
  if (err && err.name === 'UserDeniedError') {
    return new CliError('Authorization was denied on the consent screen.', {
      exitCode: EXIT_AUTH,
      nextAction: siteRef
        ? `Run: abilities-mcp reauth ${siteRef} (and click Allow on the consent screen)`
        : 'Re-run add-site and click Allow on the consent screen',
      cause: err,
    });
  }

  // Refresh token rejected by adapter → reauth.
  if (err && err.name === 'RefreshError') {
    if (code === 'reauth_required' || code === 'invalid_grant' || code === 'unauthorized_client') {
      return new CliError(`Refresh token rejected (${code || 'invalid_grant'}).`, {
        exitCode: EXIT_AUTH,
        nextAction: siteRef
          ? `Run: abilities-mcp reauth ${siteRef} to refresh consent`
          : 'Run: abilities-mcp reauth <site_id> to refresh consent',
        cause: err,
      });
    }
    if (code === 'no_refresh_token' || code === 'revoked') {
      return new CliError(err.message || 'No usable refresh token.', {
        exitCode: EXIT_AUTH,
        nextAction: siteRef
          ? `Run: abilities-mcp reauth ${siteRef}`
          : 'Run: abilities-mcp reauth <site_id>',
        cause: err,
      });
    }
    return new CliError(err.message || 'Token refresh failed.', {
      exitCode: EXIT_AUTH,
      nextAction: siteRef
        ? `Run: abilities-mcp reauth ${siteRef} if the failure persists`
        : 'Re-check site connectivity and run reauth if the failure persists',
      cause: err,
    });
  }

  // Discovery 404 / no metadata → adapter likely not installed.
  if (err && err.name === 'DiscoveryError') {
    return new CliError(err.message || 'OAuth discovery failed.', {
      exitCode: EXIT_AUTH,
      nextAction: 'Verify the site has abilities-mcp-adapter v1.5.0+ installed and reachable over HTTPS',
      cause: err,
    });
  }

  // Adapter rejected DCR — usually a configuration mismatch on the adapter.
  if (err && err.name === 'RegistrationError') {
    return new CliError(err.message || 'Dynamic Client Registration failed.', {
      exitCode: EXIT_AUTH,
      nextAction: 'Check the adapter\'s OAuth client policy and try add-site again',
      cause: err,
    });
  }

  // Token exchange rejected — typically PKCE / code re-use.
  if (err && err.name === 'TokenExchangeError') {
    return new CliError(err.message || 'Token exchange failed.', {
      exitCode: EXIT_AUTH,
      nextAction: siteRef
        ? `Run: abilities-mcp reauth ${siteRef}`
        : 'Re-run add-site to start a fresh authorization',
      cause: err,
    });
  }

  // SecretStore (keytar) unavailable on this host.
  if (err && err.name === 'SecretStoreError') {
    return new CliError(err.message || 'OS keychain unavailable.', {
      exitCode: EXIT_CONFIG,
      nextAction: 'Install OS keychain support (libsecret on Linux) or run on a host with native keychain',
      cause: err,
    });
  }

  // State machine state-token mismatch — almost always the operator
  // re-clicking an old consent link.
  if (err && err.name === 'StateMismatchError') {
    return new CliError(err.message, {
      exitCode: EXIT_AUTH,
      nextAction: siteRef
        ? `Run: abilities-mcp reauth ${siteRef} and complete the flow without re-using stale links`
        : 'Re-run add-site and complete the flow without re-using stale browser tabs',
      cause: err,
    });
  }

  // Migration failure — surfaced from config-migration.js.
  if (err && err.name === 'MigrationError') {
    return new CliError(err.message || 'Config migration failed.', {
      exitCode: EXIT_CONFIG,
      nextAction: 'Inspect wp-sites.json (and its .v1.bak) and fix the source schema',
      cause: err,
    });
  }

  // Fallback — unknown error class.
  const fallback = new CliError(err && err.message ? err.message : String(err), {
    exitCode: EXIT_GENERIC,
    cause: err,
  });
  if (progressLines) fallback.progressLines = progressLines;
  return fallback;
}

/**
 * After fromAuthError() returns, attach `progressLines` collected by the
 * command. Done via a wrapper so each `new CliError(...)` branch above stays
 * a one-liner.
 *
 * @param {CliError} cliErr
 * @param {string[]} progressLines
 * @returns {CliError}
 */
function withProgress(cliErr, progressLines) {
  if (cliErr instanceof CliError && Array.isArray(progressLines) && progressLines.length) {
    cliErr.progressLines = progressLines;
  }
  return cliErr;
}

module.exports = {
  CliError,
  fromAuthError,
  withProgress,
  EXIT_OK,
  EXIT_GENERIC,
  EXIT_USAGE,
  EXIT_CONFIG,
  EXIT_AUTH,
  EXIT_PIN_VIOLATION,
};
