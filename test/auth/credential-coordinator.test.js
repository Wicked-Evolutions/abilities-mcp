'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { CredentialCoordinator } = require('../../lib/auth/credential-coordinator');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { makeRef } = require('../../lib/auth/secret-store');

const tmpRoots = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-coordinator-'));
  tmpRoots.push(root);
  return root;
}

describe('CredentialCoordinator', () => {
  it('stores a complete generation-addressed pair in one keychain item', async () => {
    const store = new MemorySecretStore();
    const coordinator = new CredentialCoordinator({ secretStore: store, deps: { stateRoot: makeRoot() } });
    const auth = {
      access_token_ref: makeRef('abilities-mcp', 'site/access'),
      refresh_token_ref: makeRef('abilities-mcp', 'site/refresh'),
    };
    const prepared = await coordinator.preparePair({
      auth,
      tokens: { access_token: 'AT-new', refresh_token: 'RT-new' },
      accessTokenExpiresAt: '2026-10-04T00:00:00.000Z',
      refreshTokenExpiresAt: '2026-12-01T00:00:00.000Z',
      nextRefreshAt: '2026-10-03T23:55:00.000Z',
    });
    const pair = await coordinator.readPair(prepared);
    assert.equal(pair.access_token, 'AT-new');
    assert.equal(pair.refresh_token, 'RT-new');
    assert.equal(pair.generation, prepared.credential_generation);
    assert.match(prepared.credential_pair_ref, /credential-pair\/a$/);
  });

  it('uses the inactive slot and leaves the committed slot untouched', async () => {
    const store = new MemorySecretStore();
    const coordinator = new CredentialCoordinator({ secretStore: store, deps: { stateRoot: makeRoot() } });
    const auth = {
      access_token_ref: makeRef('abilities-mcp', 'site/access'),
      refresh_token_ref: makeRef('abilities-mcp', 'site/refresh'),
    };
    const first = await coordinator.preparePair({
      auth, tokens: { access_token: 'AT-1', refresh_token: 'RT-1' },
      accessTokenExpiresAt: '2026-10-04T00:00:00.000Z',
    });
    const second = await coordinator.preparePair({
      auth: first, tokens: { access_token: 'AT-2', refresh_token: 'RT-2' },
      accessTokenExpiresAt: '2026-10-05T00:00:00.000Z',
    });
    assert.match(first.credential_pair_ref, /credential-pair\/a$/);
    assert.match(second.credential_pair_ref, /credential-pair\/b$/);
    assert.equal((await coordinator.readPair(first)).access_token, 'AT-1');
    assert.equal((await coordinator.readPair(second)).access_token, 'AT-2');
  });

  it('does not steal a live credential lock', async () => {
    const root = makeRoot();
    const coordinator = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const identity = 'a'.repeat(64);
    let release;
    let entered;
    const enteredLock = new Promise((resolve) => { entered = resolve; });
    const held = coordinator.withCredentialLock(identity, 'refresh', () => new Promise((resolve) => {
      release = resolve;
      entered();
    }));
    await enteredLock;
    await assert.rejects(
      coordinator.withCredentialLock(identity, 'refresh', async () => {}),
      (err) => err.code === 'credential_operation_busy'
    );
    release();
    await held;
  });

  it('refuses a simultaneous lock attempt from a second Node process', async () => {
    const root = makeRoot();
    const worker = path.join(__dirname, 'helpers', 'credential-lock-worker.js');
    const identity = 'b'.repeat(64);
    const first = spawn(process.execPath, [worker, root, identity, '250']);
    let firstOutput = '';
    first.stdout.on('data', (chunk) => { firstOutput += chunk; });
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (firstOutput.includes('locked')) { clearInterval(timer); resolve(); }
      }, 5);
    });
    const second = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, root, identity, '0']);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
    assert.equal(second.code, 2);
    assert.match(second.output, /error:credential_operation_busy/);
    await new Promise((resolve, reject) => first.on('close', (code) => code === 0 ? resolve() : reject(new Error(String(code)))));
  });
});
