'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Create an isolated temporary home directory for a test.
 *
 * Sets BOTH `HOME` (POSIX) and `USERPROFILE` (Windows), because `os.homedir()`
 * — which the config loader uses — reads `HOME` on macOS/Linux and `USERPROFILE`
 * on win32. Overriding only `HOME` is a no-op on Windows, so tests that did so
 * silently failed to isolate there and resolved against the real home.
 *
 * @returns {{ dir: string, restore: () => void }} the temp home path and a
 *   teardown that restores the previous env vars and removes the directory.
 */
function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-home-'));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  return {
    dir,
    restore() {
      for (const key of ['HOME', 'USERPROFILE']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

module.exports = { makeTempHome };
