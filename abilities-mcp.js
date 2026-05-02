#!/usr/bin/env node
/**
 * abilities-mcp v1.0.0
 *
 * One MCP to Rule Your WordPress World.
 *
 * Unified multi-site MCP bridge for WordPress Abilities API. Replaces
 * mcp-ssh-bridge and mcp-http-bridge with a single STDIO server that
 * routes tool calls to any configured WordPress site via SSH or HTTP.
 *
 * Usage:
 *   node abilities-mcp.js                                    (uses wp-sites.json)
 *   node abilities-mcp.js --config=/path/to/wp-sites.json    (explicit config)
 *   node abilities-mcp.js --host=<ssh-host> --path=<wp-path> (legacy single-site)
 *   node abilities-mcp.js --register [--name=<name>]         (Claude Desktop setup)
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @package Wicked-Evolutions/abilities-mcp
 * @version 1.0.0
 * @license GPL-2.0-or-later
 */

'use strict';

const { createLogger } = require('./lib/logger');
const { loadConfig, buildSiteKeyEnum, resolveConfigFilePath } = require('./lib/config');
const { ConnectionPool } = require('./lib/connection-pool');
const { ToolCatalog } = require('./lib/tool-catalog');
const { McpRouter } = require('./lib/router');
const { SshTransport } = require('./lib/transports/ssh-transport');
const { migrateFile } = require('./lib/auth/config-migration');
const { KeychainSecretStore } = require('./lib/auth/keychain-secret-store');

// ---------------------------------------------------------------------------
// Subcommand routing (Phase 5 OAuth CLI)
// ---------------------------------------------------------------------------
// `abilities-mcp <subcommand>` (e.g. add-site, list-sites) dispatches to the
// OAuth CLI in lib/cli/. With no subcommand the bridge starts the MCP server
// as before — this preserves backwards compatibility for every existing
// invocation path (Claude Desktop, .mcpb bundle, bare `node abilities-mcp.js`).
const { isKnownSubcommand, runCommand, HELP_TEXT, isHelpToken } = require('./lib/cli');

const rawArgs = process.argv.slice(2);
const firstToken = rawArgs[0];

if (firstToken && isHelpToken(firstToken)) {
  process.stdout.write(HELP_TEXT.join('\n') + '\n');
  process.exit(0);
}

const isSubcommandInvocation = firstToken && isKnownSubcommand(firstToken);

if (isSubcommandInvocation) {
  (async () => {
    try {
      const { exitCode, lines, errLines } = await runCommand({
        subcommand: firstToken,
        argv: rawArgs.slice(1),
      });
      if (lines.length) process.stdout.write(lines.join('\n') + '\n');
      if (errLines.length) process.stderr.write(errLines.join('\n') + '\n');
      process.exit(exitCode);
    } catch (err) {
      // Last-resort safety net — runCommand normally catches everything.
      process.stderr.write(`abilities-mcp: ${err.message}\n`);
      process.exit(1);
    }
  })();
}

// ---------------------------------------------------------------------------
// MCP server mode — the original CLI argument parsing (no subcommand).
// Skipped when a subcommand was dispatched above; otherwise we'd race the
// IIFE's process.exit() against the bootstrap that awaits loadConfig() and
// connectDefault().
// ---------------------------------------------------------------------------

if (!isSubcommandInvocation) {
  const args = {};
  rawArgs.forEach(arg => {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.length ? rest.join('=') : true;
    }
  });

  const debug    = !!args.debug;
  const register = !!args.register;

  if (register) {
    const { registerClaudeDesktop } = require('./lib/register');
    registerClaudeDesktop({ name: args.name || 'wordpress', configPath: args.config });
    process.exit(0);
  }

  const log = createLogger(debug);
  log('abilities-mcp v1.0.0 starting');

  // Ensure SSH agent is available (macOS launchd discovery)
  SshTransport.ensureSshAuthSock();

  // -------------------------------------------------------------------------
  // Async startup — schema v1→v2 migration must complete BEFORE loadConfig.
  // -------------------------------------------------------------------------
  // Per Appendix F.5 (binding): the migration is "Triggered on first bridge
  // launch after upgrade. One-shot, non-destructive." `migrateFile` is
  // idempotent — second-run on a v2 file is a no-op. Called before
  // `loadConfig` so that when v1 is on disk, `loadConfig` reads the freshly
  // rewritten v2 file (with secrets lifted into the keychain).
  //
  // The MCP server uses a fresh `KeychainSecretStore` instance here. The
  // store is a stateless wrapper over keytar — entry identity is determined
  // entirely by (service, account), so a freshly constructed instance writes
  // to the same keychain entries the runtime/CLI later read.
  //
  // Env-var single-site mode (.mcpb path) and legacy --host/--path mode have
  // no on-disk wp-sites.json; `resolveConfigFilePath` returns null and we
  // skip migration entirely.
  (async function bootstrap() {
    const filePath = await resolveConfigFilePath(args);
    if (filePath) {
      try {
        const result = await migrateFile({
          filePath,
          secretStore: new KeychainSecretStore(),
        });
        if (result.migrated) {
          log(`Migrated wp-sites.json v1 → v2 (${result.liftedCount} secret(s) lifted; backup: ${result.backupPath})`);
        }
      } catch (err) {
        process.stderr.write(`abilities-mcp: schema migration failed: ${err.message}\n`);
        process.exit(1);
      }
    }

    let config;
    try {
      config = await loadConfig(args);
    } catch (err) {
      process.stderr.write(`abilities-mcp: ${err.message}\n`);
      process.exit(1);
    }

    const isMultiSite = config._isMultiSite;
    const siteKeys = buildSiteKeyEnum(config);
    log(`Config loaded: ${siteKeys.length} site(s): ${siteKeys.join(', ')} (default: ${config.defaultSite})`);
    log(`Multi-site mode: ${isMultiSite}`);

    const pool = new ConnectionPool(config, log);
    const catalog = new ToolCatalog(config, log);

    if (catalog.isEnabled()) {
      log('Tool filtering enabled');
    } else {
      log('Tool filtering disabled (no toolFilter in config or enabled: false)');
    }

    function sendToClient(data) {
      process.stdout.write(data + '\n');
    }

    const router = new McpRouter({
      config,
      siteKeys,
      isMultiSite,
      pool,
      catalog,
      sendToClient,
      log,
    });

    // -----------------------------------------------------------------------
    // Client STDIO processing
    // -----------------------------------------------------------------------

    let inputBuffer = '';

    process.stdin.on('data', (chunk) => {
      inputBuffer += chunk.toString();

      let newlineIdx;
      while ((newlineIdx = inputBuffer.indexOf('\n')) !== -1) {
        const line = inputBuffer.slice(0, newlineIdx);
        inputBuffer = inputBuffer.slice(newlineIdx + 1);
        if (line.trim()) {
          let msg;
          try {
            msg = JSON.parse(line.trim());
          } catch (e) {
            log(`Non-JSON from client (dropped): ${line.substring(0, 200)}`);
            continue;
          }
          router.handleClientMessage(msg, line.trim());
        }
      }
    });

    process.stdin.on('end', () => {
      log('Client stdin closed — shutting down');
      shutdown();
    });

    // -----------------------------------------------------------------------
    // Startup — connect to default site
    // -----------------------------------------------------------------------

    try {
      const transport = await pool.connectDefault((parsedMsg, rawLine) => {
        router.handleTransportMessage(parsedMsg, rawLine);
      });
      router.setDefaultTransport(transport);
      log(`Default transport connected: ${config.defaultSite}`);
      router.drainEarlyQueue();
    } catch (err) {
      process.stderr.write(`abilities-mcp: Failed to connect to default site: ${err.message}\n`);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Signal handling
    // -----------------------------------------------------------------------

    function shutdown() {
      log('Shutting down');
      pool.shutdownAll().then(() => {
        process.exit(0);
      }).catch(() => {
        process.exit(1);
      });
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('unhandledRejection', (reason) => {
      log(`Unhandled rejection: ${reason}`);
    });
  })();
}
