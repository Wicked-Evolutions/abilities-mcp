'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { freshConfig, mutateConfig, seedFromEnvIfMissing } = require('../../lib/cli/config-store');
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
    assert.equal(result.reason, 'exists');
    assert.equal(await store.get('abilities-mcp', 'seed/apppassword'), null);
  });
});
