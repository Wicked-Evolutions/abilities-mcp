'use strict';

/**
 * Cross-platform test entry point.
 *
 * Replaces the previous shell-glob npm script:
 *   node --test test/*.test.js test/auth/*.test.js test/cli/*.test.js test/transports/*.test.js
 * That form only works where a POSIX shell expands the globs before `node`
 * runs. On Windows the npm script runs under cmd/PowerShell, which pass the
 * globs through literally, so `node` finds no files and exits 1.
 *
 * This enumerates the exact same curated set in pure Node — one level per
 * listed directory, non-recursive on purpose so the test surface does not
 * silently grow with future nested files — then runs `node --test` with
 * explicit paths.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Same set the old globs matched. Keep non-recursive.
const DIRS = ['test', 'test/auth', 'test/cli', 'test/transports'];

const files = [];
for (const dir of DIRS) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') continue;
    throw err;
  }
  const inDir = entries
    .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
    .map((e) => path.join(dir, e.name))
    .sort();
  files.push(...inDir);
}

if (files.length === 0) {
  console.error('run-tests: no .test.js files found in', DIRS.join(', '));
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
