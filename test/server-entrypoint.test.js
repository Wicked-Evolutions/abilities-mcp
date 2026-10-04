'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BRIDGE_BIN = path.join(REPO_ROOT, 'abilities-mcp.js');
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function writeCapturePreload(filePath) {
  fs.writeFileSync(filePath, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const originalLoad = Module._load;
    class ForbiddenKeychainSecretStore {
      async get() { throw new Error('test must not access the operator Keychain'); }
      async set() { throw new Error('test must not access the operator Keychain'); }
      async delete() { throw new Error('test must not access the operator Keychain'); }
    }
    Module._load = function(request, parent, isMain) {
      if (request === './lib/auth/keychain-secret-store' || request === './keychain-secret-store') {
        return { KeychainSecretStore: ForbiddenKeychainSecretStore };
      }
      if (request === './lib/connection-pool' && parent && parent.filename === process.env.ABILITIES_MCP_BRIDGE_BIN) {
        return { ConnectionPool: class ConnectionPool {
          constructor(config, log, deps) {
            fs.writeFileSync(process.env.ABILITIES_MCP_CAPTURE_PATH, JSON.stringify(deps));
          }
          async connectDefault() { return null; }
          async shutdownAll() {}
        }};
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  `);
}

function runBridge(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    child.stdin.end();
  });
}

describe('server entrypoint', () => {
  it('propagates --allow-insecure to the STDIO connection pool', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'abilities-mcp-entry-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'wp-sites.json');
    const preloadPath = path.join(dir, 'capture-pool.js');
    const capturePath = path.join(dir, 'pool-deps.json');
    await fsp.writeFile(configPath, JSON.stringify({
      schema_version: 2,
      defaultSite: 'local',
      sites: { local: { transport: 'ssh', ssh: { host: 'localhost', path: '/tmp' } } },
    }), { mode: 0o600 });
    writeCapturePreload(preloadPath);

    const result = await runBridge([
      '--require', preloadPath, BRIDGE_BIN, `--config=${configPath}`, '--allow-insecure',
    ], {
      ...process.env,
      ABILITIES_MCP_BRIDGE_BIN: BRIDGE_BIN,
      ABILITIES_MCP_CAPTURE_PATH: capturePath,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.deepEqual(JSON.parse(await fsp.readFile(capturePath, 'utf8')), { allowInsecure: true });
  });

  it('recognizes the documented insecure CLI flag without allowing remote HTTP', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'abilities-mcp-cli-entry-'));
    tempDirs.push(dir);
    const preloadPath = path.join(dir, 'forbid-keychain.js');
    const configPath = path.join(dir, 'wp-sites.json');
    writeCapturePreload(preloadPath);

    const commonArgs = [
      '--require', preloadPath, BRIDGE_BIN, 'add-site', 'http://example.com',
      '--site-id=remote-http', `--config=${configPath}`,
    ];
    const env = { ...process.env, ABILITIES_MCP_BRIDGE_BIN: BRIDGE_BIN };
    const optIn = await runBridge([...commonArgs, '--allow-insecure'], env);
    const absent = await runBridge(commonArgs, env);
    const explicitFalse = await runBridge([...commonArgs, '--allow-insecure=false'], env);

    assert.equal(optIn.code, 2, optIn.stderr);
    assert.match(optIn.stderr, /only for localhost development/,
      'the documented flag must reach the post-opt-in loopback guard');
    for (const result of [absent, explicitFalse]) {
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /Provide an https:\/\/ URL or pass --allow-insecure/,
        'an absent or false documented flag must not opt into HTTP');
    }
    assert.equal(fs.existsSync(configPath), false,
      'rejected remote HTTP invocations must not create a config file');
  });
});
