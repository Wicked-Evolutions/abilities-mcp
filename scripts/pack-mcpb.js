#!/usr/bin/env node
'use strict';

/**
 * Build the .mcpb bundle with keytar prebuilds for all supported platforms.
 *
 * Why a staging directory: mcpb pack does not honor `!` re-includes inside an
 * excluded parent (verified empirically against @anthropic-ai/mcpb pack —
 * `node_modules/` excluded with `!node_modules/keytar/` ships zero keytar
 * entries). The locked sprint plan's literal fallback was to drop the global
 * `node_modules/` exclusion and explicit-allowlist every shipping package by
 * name; that works but couples the .mcpbignore to keytar's transitive deps.
 *
 * Instead, this script builds `dist-mcpb/staging/` with only what should ship
 * (the runtime surface plus a keytar package carrying prebuilds for every
 * target platform), then runs mcpb pack against staging. Single source of
 * truth for "what ships."
 *
 * Why a patched lib/keytar.js in staging: keytar 7.9.0's loader is
 * `var keytar = require('../build/Release/keytar.node')` — single hardcoded
 * slot, no platform-arch routing, no node-gyp-build. Empirically verified
 * against an unpatched bundle: loading `node_modules/keytar` from the
 * extracted .mcpb throws `MODULE_NOT_FOUND - Cannot find module
 * '../build/Release/keytar.node'` even on the host platform, because the
 * staged binaries live at `build/Release/<platform>-<arch>/keytar.node` —
 * keytar's loader only looks at the legacy slot. The patch is mandatory
 * for any cross-platform bundle to work at all.
 *
 * Safety guards (per CTO review):
 * - Pre-patch substring assertion on the upstream `lib/keytar.js` source.
 *   If a future keytar bump changes the loader shape, the assertion fails
 *   loudly here instead of silently shipping a broken bundle.
 * - keytar pinned to `~7.9.0` in package.json (patch versions only) so the
 *   substring assertion has a stable target.
 * - The patch is written ONLY to the staged copy. `node_modules/keytar/` in
 *   the project tree is byte-identical pre-pack and post-pack — `scripts/
 *   verify-pack-isolation.js` pins this property.
 * - CLI install paths (npx, npm install -g, source clone, headless CI,
 *   Docker) are untouched: each runs its own `npm install` which fetches
 *   upstream keytar verbatim. The patch never reaches any non-`.mcpb`-install
 *   path.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STAGING = path.join(PROJECT_ROOT, 'dist-mcpb', 'staging');
const OUTPUT = path.join(PROJECT_ROOT, 'abilities-mcp.mcpb');
const KEYTAR_SRC = path.join(PROJECT_ROOT, 'node_modules', 'keytar');
const KEYTAR_DST = path.join(STAGING, 'node_modules', 'keytar');

// Platforms supported by both keytar's prebuild matrix and manifest.json's
// compatibility.platforms. arm64 Linux / Windows ARM64 / FreeBSD are out of
// scope for v1.5.x — keytar publishes no prebuilds, manifest declares only
// these three OS values, and the operator's compatibility expectations are
// already aligned with this set.
const TARGETS = [
  { platform: 'darwin', arch: 'x64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'win32',  arch: 'x64' },
  { platform: 'linux',  arch: 'x64' },
];

const ROOT_FILES = [
  'abilities-mcp.js',
  'manifest.json',
  'package.json',
  'LICENSE',
  'README.md',
  'wp-sites.example.json',
];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function log(msg) {
  process.stdout.write(`[pack-mcpb] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// 1. Build clean staging dir
// ---------------------------------------------------------------------------

log('Wiping staging dir…');
fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });

log('Copying root runtime files…');
for (const f of ROOT_FILES) {
  const src = path.join(PROJECT_ROOT, f);
  const dst = path.join(STAGING, f);
  fs.copyFileSync(src, dst);
}

log('Copying lib/ recursively…');
copyDir(path.join(PROJECT_ROOT, 'lib'), path.join(STAGING, 'lib'));

// ---------------------------------------------------------------------------
// 2. Stage keytar package — only the files needed at runtime
// ---------------------------------------------------------------------------

log('Staging node_modules/keytar/ runtime files…');
fs.mkdirSync(path.join(KEYTAR_DST, 'lib'), { recursive: true });
fs.mkdirSync(path.join(KEYTAR_DST, 'build', 'Release'), { recursive: true });
fs.copyFileSync(
  path.join(KEYTAR_SRC, 'package.json'),
  path.join(KEYTAR_DST, 'package.json')
);

// ---------------------------------------------------------------------------
// 3. Fetch keytar prebuilds for every target platform/arch into the staged
//    keytar's build/Release/<platform>-<arch>/keytar.node. prebuild-install
//    always writes to ${KEYTAR_SRC}/build/Release/keytar.node — we copy the
//    binary out and into the staged subdir after each fetch, then restore
//    the host binary at the end so local dev/test keeps working.
// ---------------------------------------------------------------------------

const HOST_BINARY = path.join(KEYTAR_SRC, 'build', 'Release', 'keytar.node');
const HOST_BACKUP = path.join(KEYTAR_SRC, 'build', 'Release', 'keytar.node.host-backup');

if (!fs.existsSync(HOST_BINARY)) {
  log('Host keytar binary missing — fetching for current platform first…');
  execSync('npx --yes prebuild-install --runtime napi --target 3', {
    cwd: KEYTAR_SRC, stdio: 'inherit',
  });
}

log('Stashing host platform binary for restoration…');
fs.copyFileSync(HOST_BINARY, HOST_BACKUP);

for (const { platform, arch } of TARGETS) {
  log(`Fetching keytar prebuild: ${platform}-${arch}`);
  execSync(
    `npx --yes prebuild-install --platform ${platform} --arch ${arch} --runtime napi --target 3`,
    { cwd: KEYTAR_SRC, stdio: 'inherit' }
  );
  const targetSubdir = path.join(KEYTAR_DST, 'build', 'Release', `${platform}-${arch}`);
  fs.mkdirSync(targetSubdir, { recursive: true });
  fs.copyFileSync(HOST_BINARY, path.join(targetSubdir, 'keytar.node'));
}

log('Restoring host platform keytar binary…');
fs.copyFileSync(HOST_BACKUP, HOST_BINARY);
fs.unlinkSync(HOST_BACKUP);

// ---------------------------------------------------------------------------
// 4. Patch keytar's lib/keytar.js in the staged copy with a multi-platform-
//    aware loader. Pre-patch assertion on the upstream source guards against
//    silent breakage if a future keytar bump changes the loader shape.
// ---------------------------------------------------------------------------

const UPSTREAM_LIB_KEYTAR = path.join(KEYTAR_SRC, 'lib', 'keytar.js');
const STAGED_LIB_KEYTAR = path.join(KEYTAR_DST, 'lib', 'keytar.js');

const upstreamSource = fs.readFileSync(UPSTREAM_LIB_KEYTAR, 'utf8');
const EXPECTED_LOADER_LINE = "var keytar = require('../build/Release/keytar.node')";

if (!upstreamSource.includes(EXPECTED_LOADER_LINE)) {
  throw new Error(
    `pack-mcpb.js: upstream keytar/lib/keytar.js no longer matches expected pre-patch shape.\n` +
    `Expected substring: ${EXPECTED_LOADER_LINE}\n` +
    `Source: ${UPSTREAM_LIB_KEYTAR}\n` +
    `\n` +
    `Cause: keytar version bumped past 7.9.x and the loader shape changed.\n` +
    `Action: review the new keytar/lib/keytar.js, update the loader-patch source\n` +
    `        in this script (LOADER constant), and update EXPECTED_LOADER_LINE to\n` +
    `        the new pre-patch substring. Then re-run pack:mcpb.\n` +
    `\n` +
    `If the new keytar version routes binaries by platform-arch natively, the\n` +
    `patch may no longer be needed at all — empirically verify by extracting an\n` +
    `unpatched bundle and require()-ing keytar from it on the host platform.\n` +
    `If require succeeds, drop this patch step entirely.`
  );
}

const LOADER = `'use strict';
// Multi-platform keytar loader — generated by scripts/pack-mcpb.js for the .mcpb bundle.
// Routes the native binary load by process.platform-process.arch so a single bundle
// works across darwin x64/arm64, win32 x64, linux x64. Falls back to the legacy
// build/Release/keytar.node slot when the platform-arch subdir is absent (preserves
// CLI-install behavior in case this loader ever runs outside the .mcpb bundle).

const fs = require('fs');
const path = require('path');

const platformArch = process.platform + '-' + process.arch;
const subdirPath = path.join(__dirname, '..', 'build', 'Release', platformArch, 'keytar.node');
const fallbackPath = path.join(__dirname, '..', 'build', 'Release', 'keytar.node');
const binPath = fs.existsSync(subdirPath) ? subdirPath : fallbackPath;
const keytar = require(binPath);

function checkRequired(val, name) {
  if (!val || val.length <= 0) {
    throw new Error(name + ' is required.');
  }
}

module.exports = {
  getPassword(service, account) {
    checkRequired(service, 'Service');
    checkRequired(account, 'Account');
    return keytar.getPassword(service, account);
  },
  setPassword(service, account, password) {
    checkRequired(service, 'Service');
    checkRequired(account, 'Account');
    checkRequired(password, 'Password');
    return keytar.setPassword(service, account, password);
  },
  deletePassword(service, account) {
    checkRequired(service, 'Service');
    checkRequired(account, 'Account');
    return keytar.deletePassword(service, account);
  },
  findCredentials(service) {
    checkRequired(service, 'Service');
    return keytar.findCredentials(service);
  },
  findPassword(service) {
    checkRequired(service, 'Service');
    return keytar.findPassword(service);
  },
};
`;
fs.writeFileSync(STAGED_LIB_KEYTAR, LOADER);
log('Patched staged keytar/lib/keytar.js for multi-platform binary routing.');

// ---------------------------------------------------------------------------
// 5. Run mcpb pack against the staging dir.
// ---------------------------------------------------------------------------

log('Running mcpb pack against staging…');
execSync(
  `npx --yes @anthropic-ai/mcpb pack "${STAGING}" "${OUTPUT}"`,
  { stdio: 'inherit' }
);

log(`Bundle written to ${path.relative(PROJECT_ROOT, OUTPUT)}`);
