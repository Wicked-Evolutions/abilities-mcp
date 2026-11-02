#!/usr/bin/env node
'use strict';

/**
 * Validate the manifest with the exact MCPB package pinned in package-lock.
 * Never substitute npx or a globally installed executable: a missing local
 * tool is an actionable install failure, not a reason to package differently.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const manifest = path.join(projectRoot, 'manifest.json');
const mcpbCli = path.join(projectRoot, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');

if (!fs.existsSync(mcpbCli)) {
  throw new Error(
    `validate-mcpb.js: installed local @anthropic-ai/mcpb is missing at ${mcpbCli}.\n` +
    'Run `npm ci` from the repository root before validating.'
  );
}

execFileSync(process.execPath, [mcpbCli, 'validate', manifest], {
  cwd: projectRoot,
  stdio: 'inherit',
});
