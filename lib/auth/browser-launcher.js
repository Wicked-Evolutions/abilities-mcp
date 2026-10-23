'use strict';

const { spawn } = require('node:child_process');

/**
 * Cross-platform default-browser opener.
 *
 * Picks an OS-appropriate "open this URL in the user's default browser"
 * command and dispatches it. Returns a Promise that resolves once the launch
 * command has been spawned (we do not wait for the browser to render).
 *
 * Uses platform-native commands only — no third-party dependency.
 *   - macOS:     /usr/bin/open
 *   - Windows:   rundll32.exe url.dll,FileProtocolHandler <url>
 *   - Linux/BSD: xdg-open
 *
 * On Windows, we use `rundll32.exe url.dll,FileProtocolHandler` instead of
 * `cmd /c start` to avoid shell parsing bugs where `&`, `%XX`, and other
 * characters in OAuth URLs get re-interpreted or truncated by cmd.exe.
 *
 * Callers can override the launcher entirely via `opts.launcher` for tests
 * or unusual environments (e.g. a remote SSH session where there is no
 * display server — operator pastes the URL by hand).
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

function _commandFor(platform) {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler'] };
  return { cmd: 'xdg-open', args: [] };
}

/**
 * Open `url` in the operator's default browser.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {(url:string)=>Promise<void>|void} [opts.launcher]   Test/override seam (bypasses spawn).
 * @param {Function} [opts.spawner]                            Test seam for child_process.spawn.
 * @param {string} [opts.platform]                             Defaults to process.platform.
 * @returns {Promise<{spawned:boolean, platform:string, command?:string}>}
 */
async function openBrowser(url, opts = {}) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('openBrowser: url must be a non-empty string');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`openBrowser: refusing to open non-http(s) URL: ${url}`);
  }

  if (opts.launcher) {
    await opts.launcher(url);
    return { spawned: true, platform: 'override' };
  }

  const platform = opts.platform || process.platform;
  const { cmd, args } = _commandFor(platform);
  const spawner = opts.spawner || spawn;

  return new Promise((resolve, reject) => {
    const child = spawner(cmd, [...args, url], { stdio: 'ignore', detached: true });
    child.on('error', (err) => reject(err));
    // Once spawn-error has had a tick to surface, consider the launch dispatched.
    setImmediate(() => {
      child.unref();
      resolve({ spawned: true, platform, command: cmd });
    });
  });
}

module.exports = { openBrowser, _commandFor };
