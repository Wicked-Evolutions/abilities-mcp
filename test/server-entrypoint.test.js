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

function writeRecoveryPreload(filePath) {
  fs.writeFileSync(filePath, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === './lib/connection-pool' && parent && parent.filename === process.env.ABILITIES_MCP_BRIDGE_BIN) {
        return { ConnectionPool: class ConnectionPool {
          constructor(config) { this.config = config; this.transports = new Map(); }
          setHandshakeCache() {}
          async connectDefault() { return null; }
          async createStagedTransport(site) {
            const send = (line) => {
              const request = JSON.parse(line);
              fs.appendFileSync(process.env.ABILITIES_MCP_RECOVERY_TRACE, JSON.stringify({ site, request }) + '\\n');
              if (!transport.onMessage) return;
              if (request.method === 'initialize') {
                queueMicrotask(() => transport.onMessage({ jsonrpc: '2.0', id: request.id, result: {
                  protocolVersion: '2025-06-18', capabilities: { tools: {} },
                } }, null));
              } else if (request.method === 'tools/list') {
                queueMicrotask(() => transport.onMessage({ jsonrpc: '2.0', id: request.id, result: {
                  tools: [{ name: 'content-list', inputSchema: { type: 'object' } }],
                } }, null));
              }
            };
            const transport = { onMessage: null, async connect() {}, send, async shutdown() {} };
            return transport;
          }
          promoteStagedTransport(site, transport) { this.transports.set(site, transport); }
          async shutdownAll() { this.transports.clear(); }
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

function createJsonCollector(child) {
  const messages = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index !== -1) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    }
  });
  return {
    waitFor(predicate, timeoutMs = 3000) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for bridge response')), timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
}

describe('server entrypoint', () => {
  it('recovers a degraded STDIO bridge only after explicit reconnect, without contacting another configured site (#125)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'abilities-mcp-reconnect-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'wp-sites.json');
    const preloadPath = path.join(dir, 'recovery-pool.js');
    const tracePath = path.join(dir, 'recovery-trace.jsonl');
    await fsp.writeFile(configPath, JSON.stringify({
      schema_version: 2,
      defaultSite: 'siteA',
      sites: {
        siteA: { transport: 'ssh', ssh: { host: 'unavailable-before-restore', path: '/tmp/mcp' } },
        siteB: { transport: 'ssh', ssh: { host: 'must-not-be-contacted', path: '/tmp/mcp' } },
      },
    }), { mode: 0o600 });
    writeRecoveryPreload(preloadPath);

    const child = spawn(process.execPath, ['--require', preloadPath, BRIDGE_BIN, `--config=${configPath}`], {
      env: {
        ...process.env,
        ABILITIES_MCP_BRIDGE_BIN: BRIDGE_BIN,
        ABILITIES_MCP_RECOVERY_TRACE: tracePath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const messages = createJsonCollector(child);

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }) + '\n');
    const initialize = await messages.waitFor((message) => message.id === 1);
    assert.equal(initialize.result.capabilities.tools.listChanged, true);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'wp_bridge_reconnect', arguments: { site: 'siteA' } },
    }) + '\n');

    const recovered = await messages.waitFor((message) => message.id === 2);
    assert.equal(recovered.result.isError, undefined);
    const changed = await messages.waitFor((message) => message.method === 'notifications/tools/list_changed');
    assert.equal(changed.method, 'notifications/tools/list_changed');
    const trace = (await fsp.readFile(tracePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(trace.filter((entry) => entry.request.method === 'initialize').length, 1);
    assert.equal(trace.every((entry) => entry.site === 'siteA'), true, 'no fallback request touches siteB');

    child.stdin.end();
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, 0, stderr);
  });

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
