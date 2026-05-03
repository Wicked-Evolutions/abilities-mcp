#!/usr/bin/env node
'use strict';

/**
 * verify-pack-isolation: assert that running pack:mcpb does not mutate
 * `node_modules/keytar/` in the project tree.
 *
 * The pack script writes to `dist-mcpb/staging/` and patches keytar's
 * lib/keytar.js in the staged copy, but it also has to invoke
 * `prebuild-install` against `node_modules/keytar/` to fetch each platform's
 * binary (prebuild-install always writes to KEYTAR_SRC/build/Release/keytar.node).
 * After fetching all targets the script restores the host-platform binary at
 * the legacy slot.
 *
 * This script pins the property "node_modules/keytar/ ends up byte-identical
 * to its pre-pack state" — covering both the binary restore and any other
 * incidental mutation. Snapshots a sha256-of-sha256s before and after; fails
 * loud with a per-file diff if any change.
 *
 * Run as: `npm run verify:pack-isolation`
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const KEYTAR_DIR = path.join(PROJECT_ROOT, 'node_modules', 'keytar');

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, base));
    } else if (entry.isFile()) {
      const rel = path.relative(base, abs);
      const buf = fs.readFileSync(abs);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      out.push({ path: rel, hash, size: buf.length });
    }
  }
  return out;
}

function snapshotKeytar() {
  if (!fs.existsSync(KEYTAR_DIR)) {
    throw new Error(`node_modules/keytar/ does not exist — run \`npm install\` first.`);
  }
  return walk(KEYTAR_DIR);
}

function diff(before, after) {
  const beforeMap = new Map(before.map((e) => [e.path, e]));
  const afterMap = new Map(after.map((e) => [e.path, e]));
  const changes = [];
  for (const [p, b] of beforeMap) {
    const a = afterMap.get(p);
    if (!a) {
      changes.push(`removed: ${p}`);
    } else if (a.hash !== b.hash) {
      changes.push(`modified: ${p}  (${b.size}B → ${a.size}B; ${b.hash.slice(0, 12)}… → ${a.hash.slice(0, 12)}…)`);
    }
  }
  for (const [p] of afterMap) {
    if (!beforeMap.has(p)) {
      changes.push(`added: ${p}`);
    }
  }
  return changes;
}

function log(msg) {
  process.stdout.write(`[verify-pack-isolation] ${msg}\n`);
}

log('Snapshotting node_modules/keytar/ pre-pack…');
const before = snapshotKeytar();
log(`  ${before.length} files`);

log('Running pack:mcpb…');
execSync('node scripts/pack-mcpb.js', {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
});

log('Snapshotting node_modules/keytar/ post-pack…');
const after = snapshotKeytar();
log(`  ${after.length} files`);

const changes = diff(before, after);
if (changes.length === 0) {
  log('PASS: node_modules/keytar/ is byte-identical pre-pack and post-pack.');
  process.exit(0);
} else {
  process.stderr.write(`\n[verify-pack-isolation] FAIL: pack:mcpb mutated node_modules/keytar/\n`);
  for (const change of changes) {
    process.stderr.write(`  ${change}\n`);
  }
  process.exit(1);
}
