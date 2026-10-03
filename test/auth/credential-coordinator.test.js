'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { CredentialCoordinator } = require('../../lib/auth/credential-coordinator');
const { TokenManager } = require('../../lib/auth/token-manager');
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

function writeConfig(root, siteId, auth) {
  const file = path.join(root, 'wp-sites.json');
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 2,
    sites: { [siteId]: { url: 'https://example.test', auth, auth_status: 'active' } },
  }));
  return file;
}

function legacyAuth() {
  return {
    method: 'oauth', client_id: 'client-a',
    access_token_ref: makeRef('abilities-mcp', 'site/access'),
    refresh_token_ref: makeRef('abilities-mcp', 'site/refresh'),
    access_token_expires_at: '2026-10-04T00:00:00.000Z',
    refresh_token_expires_at: '2026-12-01T00:00:00.000Z',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
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

  it('reclaims a confirmed-dead lock without waiting past the refresh recovery budget', async () => {
    const root = makeRoot();
    const coordinator = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const identity = 'c'.repeat(64);
    const lock = path.join(root, `${require('node:crypto').createHash('sha256').update(identity).digest('hex')}.credential.lock`);
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ nonce: 'dead', pid: 99999999 }), { mode: 0o600 });
    let entered = false;
    await coordinator.withCredentialLock(identity, 'refresh', async () => { entered = true; });
    assert.equal(entered, true);
  });

  it('lets only one concurrent reclaimer acquire a confirmed-dead lock', async () => {
    const root = makeRoot();
    const identity = 'd'.repeat(64);
    const lock = path.join(root, `${require('node:crypto').createHash('sha256').update(identity).digest('hex')}.credential.lock`);
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ nonce: 'dead', pid: 99999999 }), { mode: 0o600 });
    const one = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const two = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const entered = deferred();
    const release = deferred();
    const hold = one.withCredentialLock(identity, 'refresh', async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await assert.rejects(two.withCredentialLock(identity, 'refresh', async () => {}), (err) => err.code === 'credential_operation_busy');
    release.resolve();
    await hold;
  });

  it('never lets a reclaimer that observed a dead owner remove a later normal owner', async () => {
    const root = makeRoot();
    const identity = 'e'.repeat(64);
    const lock = path.join(root, `${require('node:crypto').createHash('sha256').update(identity).digest('hex')}.credential.lock`);
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ nonce: 'dead', pid: 99999999 }), { mode: 0o600 });

    const observedDead = deferred();
    const allowLateReclaimer = deferred();
    const movedDeadLock = deferred();
    const allowReplacement = deferred();
    const b = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterDeadOwnerRead: async () => { observedDead.resolve(); await allowLateReclaimer.promise; },
      } },
    });
    const a = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterDeadOwnerMoved: async () => { movedDeadLock.resolve(); await allowReplacement.promise; },
      } },
    });
    const c = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });

    const bAttempt = b.withCredentialLock(identity, 'refresh', async () => {});
    await observedDead.promise;
    const aAttempt = a.withCredentialLock(identity, 'refresh', async () => {});
    await movedDeadLock.promise;

    const cEntered = deferred();
    const releaseC = deferred();
    const cAttempt = c.withCredentialLock(identity, 'refresh', async (owner) => {
      cEntered.resolve(owner);
      await releaseC.promise;
    });
    const cOwner = await cEntered.promise;
    allowReplacement.resolve();
    await assert.rejects(aAttempt, (err) => err.code === 'credential_recovery_interrupted');

    allowLateReclaimer.resolve();
    await assert.rejects(bAttempt, (err) => err.code === 'credential_operation_busy');
    const liveOwner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    assert.equal(liveOwner.nonce, cOwner.nonce, 'the late reclaimer did not remove C\'s successor lock');
    releaseC.resolve();
    await cAttempt;
  });

  it('fails closed when a prior dead-owner reclaim claim is interrupted', async () => {
    const root = makeRoot();
    const coordinator = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const identity = 'f'.repeat(64);
    const lock = path.join(root, `${require('node:crypto').createHash('sha256').update(identity).digest('hex')}.credential.lock`);
    fs.mkdirSync(path.join(lock, 'reclaim.dead'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ nonce: 'dead', pid: 99999999 }), { mode: 0o600 });

    await assert.rejects(
      coordinator.withCredentialLock(identity, 'refresh', async () => {}),
      (err) => err.code === 'credential_recovery_interrupted' && /Stop all bridge processes/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(lock, 'owner.json')), true, 'recovery never deletes an ambiguous lock');
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

  it('publishes a complete refreshed pair only after a durable attempt marker', async () => {
    const root = makeRoot();
    const configPath = writeConfig(root, 'site', legacyAuth());
    const store = new MemorySecretStore();
    const coordinator = new CredentialCoordinator({ secretStore: store, configPath, siteId: 'site', deps: { stateRoot: root } });
    const current = {
      siteId: 'site', accessTokenRef: makeRef('abilities-mcp', 'site/access'),
      refreshTokenRef: makeRef('abilities-mcp', 'site/refresh'), accessTokenExpiresAt: '2026-10-04T00:00:00.000Z',
      refreshTokenExpiresAt: '2026-12-01T00:00:00.000Z', _refreshToken: 'RT-old',
    };
    const marker = await coordinator.beginRefresh(current);
    let disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(disk.sites.site.auth.refresh_attempt.nonce, marker.nonce);
    await coordinator.recordRefreshAttempt(marker);
    const committed = await coordinator.commitRefresh(marker, current, { access_token: 'AT-new', refresh_token: 'RT-new' }, {
      accessTokenExpiresAt: '2026-10-04T01:00:00.000Z', refreshTokenExpiresAt: '2026-12-01T00:00:00.000Z',
      authorizationExpiresAt: null, nextRefreshAt: '2026-10-04T00:54:00.000Z', expirySource: 'authoritative',
    });
    disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(disk.sites.site.auth.refresh_attempt, undefined);
    assert.equal(disk.sites.site.auth.access_token_ref, undefined);
    assert.equal(disk.sites.site.auth.credential_generation, marker.credential_generation);
    assert.equal((await coordinator.readPair({ credential_pair_ref: committed.credentialPairRef, credential_generation: committed.credentialGeneration })).refresh_token, 'RT-new');
  });

  it('recovers a prepared complete pair after restart without retrying the old refresh token', async () => {
    const root = makeRoot();
    const configPath = writeConfig(root, 'site', legacyAuth());
    const store = new MemorySecretStore();
    const first = new CredentialCoordinator({ secretStore: store, configPath, siteId: 'site', deps: { stateRoot: root } });
    const current = { siteId: 'site', accessTokenRef: makeRef('abilities-mcp', 'site/access'), refreshTokenRef: makeRef('abilities-mcp', 'site/refresh') };
    const marker = await first.beginRefresh(current);
    await first.withConfigCommitLock('test-prepared', async ({ config }) => {
      config.sites.site.auth.refresh_attempt.prepared_metadata = {
        access_token_expires_at: '2026-10-04T01:00:00.000Z', refresh_token_expires_at: null,
        authorization_expires_at: null, next_refresh_at: '2026-10-04T00:54:00.000Z', refresh_expiry_source: 'authoritative',
      };
      return { write: true };
    });
    await first.preparePair({ credentialIdentity: marker.credential_identity, generation: marker.credential_generation,
      slot: marker.credential_pair_slot, tokens: { access_token: 'AT-ready', refresh_token: 'RT-ready' },
      accessTokenExpiresAt: '2026-10-04T01:00:00.000Z', nextRefreshAt: '2026-10-04T00:54:00.000Z' });
    const restarted = new CredentialCoordinator({ secretStore: store, configPath, siteId: 'site', deps: { stateRoot: root } });
    const recovered = await restarted.recoverPrepared(current);
    assert.equal(recovered.credentialGeneration, marker.credential_generation);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites.site.auth.refresh_attempt, undefined);
  });

  it('reloads an externally reauthorized pair before an ordinary token read', async () => {
    const root = makeRoot();
    const store = new MemorySecretStore();
    const first = new CredentialCoordinator({ secretStore: store, deps: { stateRoot: root } });
    const oldPair = await first.preparePair({ credentialIdentity: 'a'.repeat(64), auth: { credential_pair_slot: 'b' },
      tokens: { access_token: 'AT-old', refresh_token: 'RT-old' }, accessTokenExpiresAt: '2026-10-04T00:00:00.000Z' });
    const configPath = writeConfig(root, 'site', {
      method: 'oauth', client_id: 'old-client', access_token_expires_at: oldPair.access_token_expires_at,
      credential_pair_ref: oldPair.credential_pair_ref, credential_generation: oldPair.credential_generation,
      credential_identity: oldPair.credential_identity, credential_pair_slot: oldPair.credential_pair_slot,
    });
    const current = new CredentialCoordinator({ secretStore: store, configPath, siteId: 'site', deps: { stateRoot: root } });
    await current.claimOwnership(oldPair.credential_identity);
    const newPair = await first.preparePair({ credentialIdentity: oldPair.credential_identity, auth: oldPair,
      tokens: { access_token: 'AT-new', refresh_token: 'RT-new' }, accessTokenExpiresAt: '2026-10-05T00:00:00.000Z' });
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    Object.assign(disk.sites.site.auth, {
      client_id: 'new-client', credential_pair_ref: newPair.credential_pair_ref,
      credential_generation: newPair.credential_generation, credential_pair_slot: newPair.credential_pair_slot,
    });
    fs.writeFileSync(configPath, JSON.stringify(disk));
    const snapshot = await current.readValidatedSnapshot({
      siteId: 'site', tokenEndpoint: 'https://issuer.test/token', clientId: 'old-client',
      credentialPairRef: oldPair.credential_pair_ref, credentialGeneration: oldPair.credential_generation,
      credentialIdentity: oldPair.credential_identity, credentialPairSlot: oldPair.credential_pair_slot,
    });
    assert.equal(snapshot.clientId, 'new-client');
    assert.equal(snapshot._accessToken, 'AT-new');
    assert.equal(snapshot.credentialGeneration, newPair.credential_generation);
  });

  it('refreshes an existing generated pair through a real config-backed TokenManager', async () => {
    const root = makeRoot();
    const store = new MemorySecretStore();
    const seed = new CredentialCoordinator({ secretStore: store, deps: { stateRoot: root } });
    const pair = await seed.preparePair({ credentialIdentity: 'b'.repeat(64), auth: { credential_pair_slot: 'b' },
      tokens: { access_token: 'AT-old', refresh_token: 'RT-old' }, accessTokenExpiresAt: '2026-10-03T00:00:00.000Z' });
    const configPath = writeConfig(root, 'site', {
      method: 'oauth', client_id: 'client-a', access_token_expires_at: pair.access_token_expires_at,
      credential_pair_ref: pair.credential_pair_ref, credential_generation: pair.credential_generation,
      credential_identity: pair.credential_identity, credential_pair_slot: pair.credential_pair_slot,
    });
    const coordinator = new CredentialCoordinator({ secretStore: store, configPath, siteId: 'site',
      deps: { stateRoot: root, now: () => Date.parse('2026-10-03T00:00:00.000Z') } });
    const tm = new TokenManager({ secretStore: store, credentialCoordinator: coordinator,
      deps: { now: () => Date.parse('2026-10-03T00:00:00.000Z'), sleep: async () => {},
        postForm: async () => ({ statusCode: 200, json: { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600, refresh_token_timeout: 7200 } }) } });
    const result = await tm.refresh({ siteId: 'site', tokenEndpoint: 'https://issuer.test/token', clientId: 'client-a',
      credentialPairRef: pair.credential_pair_ref, credentialGeneration: pair.credential_generation,
      credentialIdentity: pair.credential_identity, credentialPairSlot: pair.credential_pair_slot,
      accessTokenExpiresAt: pair.access_token_expires_at, _accessToken: 'AT-old', _refreshToken: 'RT-old' });
    assert.equal(result.tokens.access_token, 'AT-new');
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.notEqual(disk.sites.site.auth.credential_generation, pair.credential_generation);
    assert.equal(disk.sites.site.auth.refresh_attempt, undefined);
  });
});
