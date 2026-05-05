'use strict';

const { parse } = require('./parse-args');
const { createContext } = require('./context');
const { CliError, fromAuthError, EXIT_USAGE, EXIT_OK, EXIT_GENERIC } = require('./errors');
const { renderNextAction } = require('./output');
const { migrateFile } = require('../auth/config-migration');

const COMMANDS = {
  'add-site': () => require('./commands/add-site'),
  'reauth': () => require('./commands/reauth'),
  'revoke': () => require('./commands/revoke'),
  'list-sites': () => require('./commands/list-sites'),
  'test': () => require('./commands/test'),
  'upgrade-auth': () => require('./commands/upgrade-auth'),
  // Documented in Appendix J of the design doc:
  'force-downgrade': () => require('./commands/force-downgrade'),    // J.1 — H.2.3 escape hatch
  'self-check': () => require('./commands/self-check'),              // J.2 — H.2.6 header probe
};

/**
 * Subcommand router for `abilities-mcp <subcommand> ...`.
 *
 * The router is invoked by abilities-mcp.js when the first argv token is one
 * of the known subcommand names. When it isn't, the bridge falls through to
 * MCP server mode (the original behavior).
 *
 * Tests can call `runCommand({ subcommand, argv, ctx })` directly with a
 * test context, bypassing process.argv / process.exit / stdout entirely.
 *
 * Exit codes are defined in `./errors.js` (0/1/2/3/4/5).
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

function isKnownSubcommand(name) {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name);
}

/**
 * Run a single subcommand. Pure of process / stdout — returns { exitCode,
 * lines, errLines }. The caller writes to streams and exits.
 *
 * @param {object} opts
 * @param {string} opts.subcommand
 * @param {string[]} opts.argv             Tokens after the subcommand name.
 * @param {object} [opts.ctx]              Pre-built context (tests). When
 *                                          omitted, createContext(args) is used.
 * @returns {Promise<{exitCode:number, lines:string[], errLines:string[]}>}
 */
async function runCommand(opts) {
  const args = parse(opts.argv || []);
  if (!isKnownSubcommand(opts.subcommand)) {
    return {
      exitCode: EXIT_USAGE,
      lines: [],
      errLines: [
        `abilities-mcp: unknown subcommand "${opts.subcommand}"`,
        `  → Run: abilities-mcp --help`,
      ],
    };
  }
  const cmd = COMMANDS[opts.subcommand]();
  const ctx = opts.ctx || createContext(args);

  // Schema v1→v2 migration runs before any subcommand reads the config, so
  // `upgrade-auth`, `add-site`, `list-sites`, etc. work on a fresh v1.4.x
  // upgrade without first starting the bridge as MCP server. `migrateFile`
  // is idempotent (a v2 file is a no-op) and ENOENT-safe (returns
  // missing:true for clean installs that haven't run add-site yet). The
  // migration uses `ctx.secretStore` so lifted secrets land in the same
  // store the subcommand will read from a moment later — production
  // contexts share KeychainSecretStore (entry identity is (service,
  // account), not instance-bound); tests share their MemorySecretStore.
  const preLines = [];
  try {
    if (ctx.configPath) {
      const result = await migrateFile({
        filePath: ctx.configPath,
        secretStore: ctx.secretStore,
      });
      if (result.migrated) {
        preLines.push(
          `Migrated wp-sites.json v1 → v2 (${result.liftedCount} secret(s) lifted; backup: ${result.backupPath})`
        );
      }
    }
  } catch (err) {
    const cliErr = fromAuthError(err);
    return {
      exitCode: cliErr.exitCode || EXIT_GENERIC,
      lines: [],
      errLines: renderNextAction(cliErr),
    };
  }

  try {
    const r = await cmd.run(args, ctx);
    const lines = preLines.length
      ? preLines.concat(r.lines || [])
      : (r.lines || []);
    // Commands may return non-fatal advisories alongside a success exit
    // code (e.g. add-site emits one when the multisite-discovery probe
    // degrades gracefully). Surface them on stderr without changing
    // exit semantics.
    const errLines = Array.isArray(r.errLines) ? r.errLines : [];
    return { exitCode: r.exitCode || EXIT_OK, lines, errLines };
  } catch (err) {
    const cliErr = err instanceof CliError ? err : fromAuthError(err);
    const errLines = renderNextAction(cliErr);
    if (ctx.debug && cliErr.cause && cliErr.cause.stack) {
      errLines.push('');
      errLines.push('--- debug stack ---');
      errLines.push(cliErr.cause.stack);
    }
    // If the command accumulated progress before throwing, surface it on
    // stdout — the operator sees how far the command got alongside the
    // stderr error message. Migration-success preLines also need to surface
    // when the subsequent subcommand throws.
    const progress = Array.isArray(cliErr.progressLines) ? cliErr.progressLines : [];
    const lines = preLines.length ? preLines.concat(progress) : progress;
    return {
      exitCode: cliErr.exitCode || EXIT_GENERIC,
      lines,
      errLines,
    };
  }
}

const HELP_TEXT = [
  'abilities-mcp — MCP bridge for WordPress Abilities API',
  '',
  'Subcommands:',
  '  add-site <url>                       Register a new site (OAuth by default)',
  '       --apppassword                   Use App Password authentication instead',
  '       --username=<user> --password=<pw>   (required with --apppassword)',
  '       --scope="<space-sep scopes>"    Override default DCR scope',
  '       --site-id=<id>                  Override the derived site_id',
  '       --label=<text>                  Human-readable label',
  '       --force                         Overwrite an existing site_id',
  '  reauth <site_id>                     Re-run OAuth flow for an existing site',
  '       --add-scope="<scopes>"          Merge scopes into the existing set (recommended)',
  '       --remove-scope="<scopes>"       Drop scopes by exact match (missing = no-op warning)',
  '       --scope="<scopes>"              Replace the entire scope set (warns if dropping any)',
  '                                       (the three flags above are mutually exclusive;',
  '                                        accept comma- or space-separated scope lists)',
  '  revoke <site_id>                     Revoke OAuth tokens (local + remote)',
  '  list-sites                           Show configured sites + auth status',
  '  test <site_id>                       Ping the adapter and report scopes',
  '  upgrade-auth <site_id>               Migrate App Password → OAuth (Step 1-3)',
  '       --confirm                       Step 4: remove App Password fallback',
  '  force-downgrade <site_id>            Override OAuth pinning (H.2.3)',
  '       --i-understand-the-risk         (required)',
  '       --reason="<text>"               Audit message (visible in list-sites for 30 days)',
  '  self-check <site_id>                 Probe Authorization-header survival (H.2.6)',
  '',
  'Global flags:',
  '  --config=<path>        Use this wp-sites.json (defaults: ./wp-sites.json or',
  '                         ~/.abilities-mcp/wp-sites.json)',
  '  --debug                Include cause stack on errors',
  '  --allow-insecure       Allow plain HTTP (localhost dev only)',
  '',
  'Exit codes:',
  '  0  success',
  '  1  unexpected error',
  '  2  usage error',
  '  3  config error (wp-sites.json)',
  '  4  auth failure (consent denied / token rejected / network)',
  '  5  capability-pinning violation (H.2.3 — pinned site lost OAuth)',
];

function isHelpToken(tok) {
  return tok === '-h' || tok === '--help' || tok === 'help';
}

module.exports = {
  isKnownSubcommand,
  runCommand,
  COMMANDS,
  HELP_TEXT,
  isHelpToken,
};
