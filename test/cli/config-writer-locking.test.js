'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { freshConfig, mutateConfig, seedFromEnvIfMissing } = require('../../lib/cli/config-store');
const { CredentialCoordinator } = require('../../lib/auth/credential-coordinator');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-config-writer-'));
  dirs.push(dir);
  return path.join(dir, 'wp-sites.json');
}

function appPasswordSite(id) {
  return {
    url: `https://${id}.example`,
    label: id,
    auth: { method: 'apppassword', username: id, password_ref: `keychain://abilities-mcp/${id}/apppassword` },
    auth_status: 'active',
  };
}

function configLockLifecycle(configPath) {
  const coordinationDir = path.join(path.dirname(configPath), '.abilities-mcp-coordination');
  let entries;
  try {
    entries = fs.readdirSync(coordinationDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { coordinationDirectory: false, configLocks: 0, ownerFiles: 0, reclaimMarkers: 0 };
    }
    return {
      coordinationDirectory: null,
      configLocks: null,
      ownerFiles: null,
      reclaimMarkers: null,
      readErrorCode: error && error.code || null,
    };
  }

  const locks = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.config.lock'));
  let ownerFiles = 0;
  let reclaimMarkers = 0;
  for (const lock of locks) {
    try {
      for (const child of fs.readdirSync(path.join(coordinationDir, lock.name), { withFileTypes: true })) {
        if (child.isFile() && child.name === 'owner.json') ownerFiles += 1;
        if (child.isDirectory() && child.name.startsWith('reclaim.')) reclaimMarkers += 1;
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        return {
          coordinationDirectory: true,
          configLocks: locks.length,
          ownerFiles,
          reclaimMarkers,
          readErrorCode: error && error.code || null,
        };
      }
    }
  }
  return { coordinationDirectory: true, configLocks: locks.length, ownerFiles, reclaimMarkers };
}

function seedDiagnostic(result, configPath) {
  const error = result && result.error;
  const cause = error && error.cause;
  return {
    reason: result && result.reason || null,
    error: error ? {
      name: error.name || null,
      code: error.code || null,
      cause: cause ? { name: cause.name || null, code: cause.code || null } : null,
    } : null,
    lockLifecycle: configLockLifecycle(configPath),
  };
}

function runWriter(configPath, siteId, delayMs) {
  const configStore = path.resolve(__dirname, '../../lib/cli/config-store.js');
  const source = `
    const { mutateConfig } = require(process.argv[1]);
    const file = process.argv[2], site = process.argv[3], delay = Number(process.argv[4]);
    mutateConfig(file, 'two-process-config-writer', async (config) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      config.sites[site] = {
        url: 'https://' + site + '.example',
        label: site,
        auth: { method: 'apppassword', username: site, password_ref: 'keychain://abilities-mcp/' + site + '/apppassword' },
        auth_status: 'active',
      };
    }).catch((error) => { console.error(error.stack); process.exitCode = 1; });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, configStore, configPath, siteId, String(delayMs)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
  });
}

describe('CLI config commit writers', () => {
  it('preserves different-site mutations from two independent processes', async () => {
    const configPath = tempConfig();
    const config = freshConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    await Promise.all([
      runWriter(configPath, 'alpha', 30),
      runWriter(configPath, 'bravo', 0),
    ]);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(Object.keys(written.sites).sort(), ['alpha', 'bravo']);
  });

  it('does not replace a concurrently created config while environment seeding', async () => {
    const configPath = tempConfig();
    const store = new MemorySecretStore();
    let entered;
    const writerEntered = new Promise((resolve) => { entered = resolve; });
    let release;
    const releaseWriter = new Promise((resolve) => { release = resolve; });
    const writer = mutateConfig(configPath, 'concurrent-first-site', async (config) => {
      entered();
      await releaseWriter;
      config.defaultSite = 'manual';
      config.sites.manual = appPasswordSite('manual');
    }, { initialConfig: freshConfig });
    await writerEntered;
    const seed = seedFromEnvIfMissing(configPath, {
      ABILITIES_MCP_URL: 'https://seed.example',
      ABILITIES_MCP_USERNAME: 'seed',
      ABILITIES_MCP_PASSWORD: 'seed-password',
    }, { secretStore: store });
    release();

    const [, result] = await Promise.all([writer, seed]);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(Object.keys(written.sites), ['manual']);
    assert.equal(result.seeded, false);
    assert.equal(
      result.reason,
      'exists',
      `concurrent seed diagnostic: ${JSON.stringify(seedDiagnostic(result, configPath))}`
    );
    assert.deepEqual(configLockLifecycle(configPath), {
      coordinationDirectory: true,
      configLocks: 0,
      ownerFiles: 0,
      reclaimMarkers: 0,
    });
    assert.equal(await store.get('abilities-mcp', 'seed/apppassword'), null);
  });

  it('does not leave an ownerless active config lock when legacy recursive cleanup would partially fail', async () => {
    const configPath = tempConfig();
    const store = new MemorySecretStore();
    let entered;
    const writerEntered = new Promise((resolve) => { entered = resolve; });
    let release;
    const releaseWriter = new Promise((resolve) => { release = resolve; });
    const writer = mutateConfig(configPath, 'manual-first-site', async (config) => {
      entered();
      await releaseWriter;
      config.defaultSite = 'manual';
      config.sites.manual = appPasswordSite('manual');
    }, { initialConfig: freshConfig });
    await writerEntered;

    const originalRm = fs.promises.rm;
    let legacyCleanupInvoked = false;
    fs.promises.rm = async (target, options) => {
      if (!legacyCleanupInvoked && String(target).endsWith('.config.lock') && options && options.recursive) {
        legacyCleanupInvoked = true;
        await fs.promises.unlink(path.join(target, 'owner.json'));
        const error = new Error('simulated partial lock cleanup');
        error.code = 'EPERM';
        throw error;
      }
      return originalRm(target, options);
    };
    try {
      const seed = seedFromEnvIfMissing(configPath, {
        ABILITIES_MCP_URL: 'https://seed.example',
        ABILITIES_MCP_USERNAME: 'seed',
        ABILITIES_MCP_PASSWORD: 'seed-password',
      }, { secretStore: store });
      release();
      const [, result] = await Promise.all([writer, seed]);

      assert.equal(legacyCleanupInvoked, false, 'normal active-lock release no longer recursively removes the canonical lock');
      assert.equal(result.seeded, false);
      assert.equal(result.reason, 'exists');
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites), ['manual']);
      assert.deepEqual(configLockLifecycle(configPath), {
        coordinationDirectory: true,
        configLocks: 0,
        ownerFiles: 0,
        reclaimMarkers: 0,
      });
    } finally {
      fs.promises.rm = originalRm;
    }
  });

  it('preserves manual config when seeding races a retired config-lock cleanup', async () => {
    const configPath = tempConfig();
    const store = new MemorySecretStore();
    const retired = {};
    retired.promise = new Promise((resolve) => { retired.resolve = resolve; });
    const allowCleanup = {};
    allowCleanup.promise = new Promise((resolve) => { allowCleanup.resolve = resolve; });
    const manual = new CredentialCoordinator({
      secretStore: {},
      configPath,
      deps: { lockHooks: {
        afterOwnedLockRetired: async () => {
          retired.resolve();
          await allowCleanup.promise;
        },
      } },
    });

    const manualWrite = manual.withConfigCommitLock('manual-first-site', async ({ config }) => {
      config.defaultSite = 'manual';
      config.sites.manual = appPasswordSite('manual');
      return { write: true, value: 'manual-written' };
    }, { initialConfig: freshConfig });
    await retired.promise;

    const seeded = await seedFromEnvIfMissing(configPath, {
      ABILITIES_MCP_URL: 'https://seed.example',
      ABILITIES_MCP_USERNAME: 'seed',
      ABILITIES_MCP_PASSWORD: 'seed-password',
    }, { secretStore: store });
    assert.equal(seeded.seeded, false);
    assert.equal(seeded.reason, 'exists');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites), ['manual']);
    assert.equal(await store.get('abilities-mcp', 'seed/apppassword'), null);

    allowCleanup.resolve();
    assert.equal(await manualWrite, 'manual-written');
    assert.deepEqual(configLockLifecycle(configPath), {
      coordinationDirectory: true,
      configLocks: 0,
      ownerFiles: 0,
      reclaimMarkers: 0,
    });
  });
});
