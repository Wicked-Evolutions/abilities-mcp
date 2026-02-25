'use strict';

const fs = require('fs');

/**
 * Create a file-based debug logger (opt-in via --debug flag).
 * Writes to /tmp/wp-abilities-mcp.log when enabled, no-op otherwise.
 */
function createLogger(enabled, logPath) {
  if (!enabled) return function noop() {};

  const path = logPath || '/tmp/wp-abilities-mcp.log';
  let fd = null;

  return function log(msg) {
    if (!fd) fd = fs.openSync(path, 'a');
    fs.writeSync(fd, `[${new Date().toISOString()}] ${msg}\n`);
  };
}

module.exports = { createLogger };
