'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'abilities-mcp.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'keychain-fixture-preload.js');
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(predicate, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function json(res, value) {
  const body = JSON.stringify(value);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function records(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

async function exerciseShutdown(kind) {
  const selectedPort = await unusedPort();
  const otherPort = await unusedPort();
  const selected = `http://127.0.0.1:${selectedPort}`;
  const otherOrigin = `http://127.0.0.1:${otherPort}`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'abilities-mcp-entrypoint-shutdown-'));
  tempDirs.push(dir);
  await fsp.chmod(dir, 0o700);
  const stateHome = path.join(dir, 'state');
  await fsp.mkdir(stateHome, { mode: 0o700 });
  const persistPath = path.join(dir, 'persist.log');
  const past = new Date(Date.now() - 60000).toISOString();
  const future = new Date(Date.now() + 3600000).toISOString();
  const site = (id, origin) => ({
    url: origin, allowInsecure: true, mcp_resource: `${origin}/mcp`,
    auth: { method: 'oauth', client_id: 'fixture-client',
      access_token_ref: `keychain://abilities-mcp/${id}/access`, refresh_token_ref: `keychain://abilities-mcp/${id}/refresh`,
      access_token_expires_at: past, refresh_token_expires_at: future, next_refresh_at: past },
  });
  const configPath = path.join(dir, 'wp-sites.json');
  await fsp.writeFile(configPath, JSON.stringify({ schema_version: 2, defaultSite: 'selected',
    sites: { selected: site('selected', selected), other: site('other', otherOrigin) } }), { mode: 0o600 });

  const state = { tokenPosts: 0, resourcePosts: 0, otherPosts: 0 };
  let main; let otherServer; let stderr = ''; let output = '';
  const child = spawn(process.execPath, ['--require', PRELOAD, BIN, `--config=${configPath}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XDG_STATE_HOME: stateHome, FIXTURE_PERSIST_PATH: persistPath, FIXTURE_PERSIST_DELAY_MS: '300' },
  });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  try {
    await until(() => stderr.includes('entering degraded mode'), `${kind} degraded boot`);
    main = http.createServer((req, res) => {
      if (req.url === '/.well-known/oauth-authorization-server') return json(res, { issuer: selected, authorization_endpoint: `${selected}/authorize`, token_endpoint: `${selected}/token` });
      if (req.url === '/.well-known/oauth-protected-resource') return json(res, { resource: `${selected}/mcp`, authorization_servers: [selected] });
      if (req.url === '/token') { state.tokenPosts += 1; return json(res, { access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, refresh_token_timeout: 3600 }); }
      if (req.url === '/mcp') state.resourcePosts += 1;
      res.writeHead(500); res.end();
    });
    otherServer = http.createServer((_req, res) => { state.otherPosts += 1; res.writeHead(500); res.end(); });
    await new Promise((resolve) => main.listen(selectedPort, '127.0.0.1', resolve));
    await new Promise((resolve) => otherServer.listen(otherPort, '127.0.0.1', resolve));
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    await until(() => output.includes('"id":1'), `${kind} initialize`);
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wp_bridge_reconnect', arguments: { site: 'selected' } } });
    await until(() => records(persistPath).some((line) => line.startsWith('started ')), `${kind} pair write`);
    if (kind === 'EOF') child.stdin.end(); else child.kill('SIGTERM');
    const closed = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, at: Date.now() }));
    });
    const lines = records(persistPath);
    const settled = lines.find((line) => line.startsWith('settled '));
    assert.equal(closed.code, 0, stderr);
    assert.equal(closed.signal, null, stderr);
    assert.ok(settled, `${kind}: pair write must settle before process exit`);
    assert.ok(Number(settled.split(' ')[1]) <= closed.at);
    assert.equal(state.tokenPosts, 1);
    assert.equal(state.resourcePosts, 0, `${kind}: cancellation prevents a resource POST after persistence`);
    assert.equal(state.otherPosts, 0, `${kind}: no fallback contacts the other site`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (main) await new Promise((resolve) => main.close(resolve));
    if (otherServer) await new Promise((resolve) => otherServer.close(resolve));
  }
}

describe('entrypoint recovery shutdown', () => {
  it('waits for a held config-backed credential write on EOF and SIGTERM', async () => {
    await exerciseShutdown('EOF');
    await exerciseShutdown('SIGTERM');
  });
});
