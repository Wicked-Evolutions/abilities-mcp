'use strict';

const { parse } = require('./parse-args');
const { createContext } = require('./context');
const { CliError, fromAuthError, EXIT_USAGE, EXIT_OK, EXIT_GENERIC } = require('./errors');
const { renderNextAction } = require('./output');

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
  try {
    const r = await cmd.run(args, ctx);
    return { exitCode: r.exitCode || EXIT_OK, lines: r.lines || [], errLines: [] };
  } catch (err) {
    const cliErr = err instanceof CliError ? err : fromAuthError(err);
    const errLines = renderNextAction(cliErr);
    if (ctx.debug && cliErr.cause && cliErr.cause.stack) {
      errLines.push('');
      errLines.push('--- debug stack ---');
      errLines.push(cliErr.cause.stack);
    }
    return {
      exitCode: cliErr.exitCode || EXIT_GENERIC,
      // If the command accumulated progress before throwing, surface it on
      // stdout — the operator sees how far the command got alongside the
      // stderr error message.
      lines: Array.isArray(cliErr.progressLines) ? cliErr.progressLines : [],
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
