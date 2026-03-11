'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Create a file-based debug logger (opt-in via --debug flag).
 * Writes to ~/.abilities-mcp/logs/abilities-mcp.log when enabled, no-op otherwise.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
function createLogger(enabled, logPath) {
  if (!enabled) return function noop() {};

  const defaultDir = path.join(os.homedir(), '.abilities-mcp', 'logs');
  const logFile = logPath || path.join(defaultDir, 'abilities-mcp.log');
  const logDir = path.dirname(logFile);

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }

  try {
    const stat = fs.lstatSync(logFile);
    if (stat.isSymbolicLink()) {
      process.stderr.write(`abilities-mcp: refusing to write to symlink: ${logFile}\n`);
      return function noop() {};
    }
  } catch (e) {
    // File doesn't exist yet — fine
  }

  let fd = null;

  return function log(msg) {
    if (!fd) fd = fs.openSync(logFile, 'a', 0o600);
    fs.writeSync(fd, `[${new Date().toISOString()}] ${msg}\n`);
  };
}

module.exports = { createLogger };
