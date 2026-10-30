'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const { CredentialCoordinator } = require('../../lib/auth/credential-coordinator');
const { TokenManager } = require('../../lib/auth/token-manager');
const { RefreshError } = require('../../lib/auth/errors');
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

function credentialLockPath(root, identity) {
  return path.join(root, `${require('node:crypto').createHash('sha256').update(identity).digest('hex')}.credential.lock`);
}

async function configuredPairFixture(root, now) {
  const store = new MemorySecretStore();
  const seed = new CredentialCoordinator({ secretStore: store, deps: { stateRoot: root } });
  const identity = 'e'.repeat(64);
  const accessTokenExpiresAt = new Date(now + 240_000).toISOString();
  const pair = await seed.preparePair({
    credentialIdentity: identity,
    auth: { credential_pair_slot: 'b' },
    tokens: { access_token: 'AT-old', refresh_token: 'RT-old' },
    accessTokenExpiresAt,
    refreshTokenExpiresAt: new Date(now + 90 * 24 * 3600 * 1000).toISOString(),
  });
  const configPath = writeConfig(root, 'site', {
    method: 'oauth', client_id: 'client-a',
    credential_pair_ref: pair.credential_pair_ref,
    credential_generation: pair.credential_generation,
    credential_identity: pair.credential_identity,
    credential_pair_slot: pair.credential_pair_slot,
    access_token_expires_at: pair.access_token_expires_at,
    refresh_token_expires_at: pair.refresh_token_expires_at,
  });
  const coordinator = new CredentialCoordinator({
    secretStore: store, configPath, siteId: 'site', deps: { stateRoot: root, now: () => now },
  });
  const siteAuth = {
    siteId: 'site', siteUrl: 'https://example.test', tokenEndpoint: 'https://issuer.test/token', clientId: 'client-a',
    credentialPairRef: pair.credential_pair_ref, credentialGeneration: pair.credential_generation,
    credentialIdentity: pair.credential_identity, credentialPairSlot: pair.credential_pair_slot,
    accessTokenExpiresAt: pair.access_token_expires_at,
    refreshTokenExpiresAt: pair.refresh_token_expires_at,
  };
  return { store, configPath, coordinator, siteAuth };
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

  it('makes a successor active before delayed retired-lock cleanup completes', async () => {
    const root = makeRoot();
    const identity = 'release-boundary'.repeat(4);
    const retired = deferred();
    const allowCleanup = deferred();
    const first = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterOwnedLockRetired: async ({ owner }) => {
          retired.resolve(owner);
          await allowCleanup.promise;
        },
      } },
    });
    const second = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const secondEntered = deferred();
    const releaseSecond = deferred();

    const firstAttempt = first.withCredentialLock(identity, 'refresh', async () => 'first-result');
    const firstOwner = await retired.promise;
    const secondAttempt = second.withCredentialLock(identity, 'refresh', async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
      return 'second-result';
    });
    await secondEntered.promise;

    const activeOwner = JSON.parse(fs.readFileSync(path.join(credentialLockPath(root, identity), 'owner.json'), 'utf8'));
    assert.notEqual(activeOwner.nonce, firstOwner.nonce, 'the successor owns the canonical lock while retired cleanup is paused');

    allowCleanup.resolve();
    assert.equal(await firstAttempt, 'first-result');
    assert.equal(fs.existsSync(credentialLockPath(root, identity)), true, 'retired cleanup does not remove the successor lock');
    releaseSecond.resolve();
    assert.equal(await secondAttempt, 'second-result');
  });

  it('leaves only non-authoritative residue after a partial retired-cleanup fault', async () => {
    const root = makeRoot();
    const identity = 'release-residue'.repeat(4);
    const retired = deferred();
    const diagnostics = [];
    const first = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterOwnedLockRetired: async ({ retiredPath }) => {
          await fs.promises.unlink(path.join(retiredPath, 'owner.json'));
          retired.resolve(retiredPath);
          throw new Error('simulated retired cleanup fault');
        },
        ownedLockReleaseDiagnostic: async ({ code }) => diagnostics.push(code),
      } },
    });
    const second = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const firstAttempt = first.withCredentialLock(identity, 'refresh', async () => 'committed-result');
    const retiredPath = await retired.promise;
    let successorEntered = false;
    await second.withCredentialLock(identity, 'refresh', async () => { successorEntered = true; });

    assert.equal(await firstAttempt, 'committed-result', 'cleanup failure does not alter the callback result');
    assert.equal(successorEntered, true, 'a successor can acquire after the old owner has retired');
    assert.equal(fs.existsSync(credentialLockPath(root, identity)), false, 'no ownerless canonical lock remains after the partial fault');
    assert.equal(fs.existsSync(retiredPath), true, 'the failed cleanup leaves only the retired residue');
    assert.deepEqual(diagnostics, ['credential_lock_retired_cleanup_failed']);
  });

  it('does not release a foreign replacement owner and preserves callback results', async () => {
    const root = makeRoot();
    const identity = 'release-foreign'.repeat(4);
    const lock = credentialLockPath(root, identity);
    const diagnostics = [];
    const coordinator = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        beforeOwnedLockRename: async ({ lockPath }) => {
          await fs.promises.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ nonce: 'foreign', pid: process.pid + 1 }), { mode: 0o600 });
        },
        ownedLockReleaseDiagnostic: async ({ code }) => diagnostics.push(code),
      } },
    });

    assert.equal(await coordinator.withCredentialLock(identity, 'refresh', async () => 'callback-result'), 'callback-result');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')), { nonce: 'foreign', pid: process.pid + 1 });
    assert.deepEqual(diagnostics, ['credential_lock_release_owner_changed']);
  });

  it('does not delete a changed retired owner', async () => {
    const root = makeRoot();
    const identity = 'release-retired-foreign'.repeat(4);
    const diagnostics = [];
    let retiredPath;
    const coordinator = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterOwnedLockRetired: async (details) => {
          retiredPath = details.retiredPath;
          await fs.promises.writeFile(path.join(retiredPath, 'owner.json'), JSON.stringify({ nonce: 'foreign', pid: process.pid + 1 }), { mode: 0o600 });
        },
        ownedLockReleaseDiagnostic: async ({ code }) => diagnostics.push(code),
      } },
    });

    assert.equal(await coordinator.withCredentialLock(identity, 'refresh', async () => 'callback-result'), 'callback-result');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(retiredPath, 'owner.json'), 'utf8')), { nonce: 'foreign', pid: process.pid + 1 });
    assert.deepEqual(diagnostics, ['credential_lock_retired_owner_changed']);
  });

  it('retains retired locks with unexpected contents', async () => {
    const root = makeRoot();
    const identity = 'release-retired-contents'.repeat(4);
    const diagnostics = [];
    let retiredPath;
    const coordinator = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterOwnedLockRetired: async (details) => {
          retiredPath = details.retiredPath;
          await fs.promises.writeFile(path.join(retiredPath, 'unexpected'), 'keep');
        },
        ownedLockReleaseDiagnostic: async ({ code }) => diagnostics.push(code),
      } },
    });

    assert.equal(await coordinator.withCredentialLock(identity, 'refresh', async () => 'callback-result'), 'callback-result');
    assert.equal(fs.existsSync(path.join(retiredPath, 'owner.json')), true);
    assert.equal(fs.existsSync(path.join(retiredPath, 'unexpected')), true);
    assert.deepEqual(diagnostics, ['credential_lock_retired_contents_changed']);
  });

  it('does not follow a substituted retired-lock directory symlink', async (t) => {
    const root = makeRoot();
    const probeTarget = path.join(root, 'symlink-probe-target');
    const probeLink = path.join(root, 'symlink-probe-link');
    fs.mkdirSync(probeTarget);
    try {
      fs.symlinkSync(probeTarget, probeLink, 'dir');
      fs.unlinkSync(probeLink);
    } catch (error) {
      if (error && error.code === 'EPERM') {
        t.skip('the current Windows policy does not permit test directory symlinks');
        return;
      }
      throw error;
    }

    const identity = 'release-retired-symlink'.repeat(4);
    const substituted = deferred();
    const allowValidation = deferred();
    const diagnostics = [];
    const first = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterOwnedLockRetired: async ({ retiredPath }) => {
          const originalPath = `${retiredPath}.original`;
          const unrelatedPath = path.join(root, 'unrelated-lock-target');
          await fs.promises.rename(retiredPath, originalPath);
          await fs.promises.mkdir(unrelatedPath);
          await fs.promises.copyFile(path.join(originalPath, 'owner.json'), path.join(unrelatedPath, 'owner.json'));
          await fs.promises.symlink(unrelatedPath, retiredPath, 'dir');
          substituted.resolve({ retiredPath, originalPath, unrelatedPath });
          await allowValidation.promise;
        },
        ownedLockReleaseDiagnostic: async ({ code }) => diagnostics.push(code),
      } },
    });
    const second = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const secondEntered = deferred();
    const releaseSecond = deferred();
    const firstAttempt = first.withCredentialLock(identity, 'refresh', async () => 'committed-result');
    const paths = await substituted.promise;
    const secondAttempt = second.withCredentialLock(identity, 'refresh', async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
    });
    await secondEntered.promise;

    allowValidation.resolve();
    assert.equal(await firstAttempt, 'committed-result');
    assert.equal(fs.lstatSync(paths.retiredPath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(paths.originalPath, 'owner.json')), true, 'the original retired directory is retained');
    assert.equal(fs.existsSync(path.join(paths.unrelatedPath, 'owner.json')), true, 'the unrelated target is never followed or deleted');
    assert.equal(fs.existsSync(credentialLockPath(root, identity)), true, 'the successor remains at the canonical lock path');
    assert.deepEqual(diagnostics, ['credential_lock_retired_owner_changed']);
    releaseSecond.resolve();
    await secondAttempt;
  });

  it('preserves the active owner and original callback error when the release rename fails', async () => {
    const root = makeRoot();
    const successIdentity = 'release-rename-success'.repeat(4);
    const errorIdentity = 'release-rename-error'.repeat(4);
    const diagnostics = [];
    const original = new Error('original callback failure');
    const coordinator = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        beforeOwnedLockRename: async () => { throw new Error('simulated rename failure'); },
        ownedLockReleaseDiagnostic: async ({ code }) => diagnostics.push(code),
      } },
    });

    assert.equal(await coordinator.withCredentialLock(successIdentity, 'refresh', async () => 'callback-result'), 'callback-result');
    await assert.rejects(
      coordinator.withCredentialLock(errorIdentity, 'refresh', async () => { throw original; }),
      (error) => error === original
    );
    for (const identity of [successIdentity, errorIdentity]) {
      const owner = JSON.parse(fs.readFileSync(path.join(credentialLockPath(root, identity), 'owner.json'), 'utf8'));
      assert.equal(typeof owner.nonce, 'string');
      assert.equal(owner.pid, process.pid);
    }
    assert.deepEqual(diagnostics, [
      'credential_lock_release_rename_failed',
      'credential_lock_release_rename_failed',
    ]);
  });

  it('keeps release diagnostics nonfatal after the stderr pipe is closed', async () => {
    const root = makeRoot();
    const coordinatorPath = path.resolve(__dirname, '../../lib/auth/credential-coordinator.js');
    const source = `
      const { CredentialCoordinator } = require(process.argv[1]);
      const root = process.argv[2];
      const coordinator = new CredentialCoordinator({
        secretStore: {},
        deps: { stateRoot: root, lockHooks: {
          beforeOwnedLockRename: async () => { throw new Error('simulate rename failure'); },
        } },
      });
      process.stdout.write('ready\\n');
      process.stdin.once('data', async () => {
        try {
          const success = await coordinator.withCredentialLock('stderr-success', 'refresh', async () => 'committed');
          const original = new Error('original callback failure');
          let preserved = false;
          try {
            await coordinator.withCredentialLock('stderr-error', 'refresh', async () => { throw original; });
          } catch (error) {
            preserved = error === original;
          }
          process.stdout.write(JSON.stringify({ success, preserved }) + '\\n');
        } catch (error) {
          process.stdout.write(JSON.stringify({ unexpected: error && error.message }) + '\\n');
          process.exitCode = 1;
        }
      });
    `;
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', source, coordinatorPath, root], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let sent = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('timed out waiting for closed-stderr diagnostic child'));
      }, 3_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes('ready\n')) {
          sent = true;
          child.stderr.destroy();
          child.stdin.end('go\n');
        }
      });
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        const lines = stdout.trim().split('\n');
        let result = null;
        try { result = JSON.parse(lines.at(-1)); } catch {}
        resolve({ code, result, stdout });
      });
    });
    assert.equal(outcome.code, 0, JSON.stringify(outcome));
    assert.deepEqual(outcome.result, { success: 'committed', preserved: true });
  });

  it('keeps a delayed backpressured stderr diagnostic nonfatal', async () => {
    const root = makeRoot();
    const coordinatorPath = path.resolve(__dirname, '../../lib/auth/credential-coordinator.js');
    const source = `
      const { spawn } = require('node:child_process');
      const { CredentialCoordinator } = require(process.argv[1]);
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let releases = 0;
      const coordinator = new CredentialCoordinator({
        secretStore: {}, deps: { stateRoot: process.argv[2], lockHooks: {
          beforeOwnedLockRename: async () => {
            if (releases++ === 0) return;
            const filler = spawn(process.execPath, ['-e', "const chunk = Buffer.alloc(65536, 'x'); for (;;) process.stderr.write(chunk);"], {
              stdio: ['ignore', 'ignore', 2],
            });
            filler.unref();
            await delay(1300);
            throw new Error('simulate delayed rename failure');
          },
        } },
      });
      (async () => {
        const success = await coordinator.withCredentialLock('stderr-delayed-success', 'refresh', async () => 'committed');
        const original = new Error('original callback failure');
        let preserved = false;
        try {
          await coordinator.withCredentialLock('stderr-delayed-error', 'refresh', async () => { throw original; });
        } catch (error) {
          preserved = error === original;
        }
        process.stdout.write(JSON.stringify({ success, preserved }) + '\\n');
        process.stdin.resume();
        process.stdin.once('data', () => {});
      })().catch((error) => {
        process.stdout.write(JSON.stringify({ unexpected: error && error.message }) + '\\n');
        process.exitCode = 1;
        process.stdin.resume();
        process.stdin.once('data', () => {});
      });
    `;
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', source, coordinatorPath, root], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let closed = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`timed out waiting for delayed backpressured diagnostic child: ${stdout}`));
      }, 8_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!closed && stdout.includes('\n')) {
          setTimeout(() => {
            closed = true;
            child.stderr.destroy();
            child.stdin.end('finish\n');
          }, 1_300);
        }
      });
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        let result = null;
        try { result = JSON.parse(stdout.trim()); } catch {}
        resolve({ code, result, stdout, closed });
      });
    });
    assert.equal(outcome.closed, true, JSON.stringify(outcome));
    assert.equal(outcome.code, 0, JSON.stringify(outcome));
    assert.deepEqual(outcome.result, { success: 'committed', preserved: true });
  });

  it('waits for a live initializer to record its owner instead of declaring interrupted recovery', async () => {
    const root = makeRoot();
    const identity = 'b'.repeat(64);
    const directoryCreated = deferred();
    const allowOwnerWrite = deferred();
    const ownerlessObserved = deferred();
    const entered = deferred();
    const release = deferred();
    const first = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterLockDirectoryCreated: async () => {
          directoryCreated.resolve();
          await allowOwnerWrite.promise;
        },
      } },
    });
    const second = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        ownerlessLockObserved: async () => ownerlessObserved.resolve(),
      } },
    });
    const firstAttempt = first.withCredentialLock(identity, 'refresh', async () => {
      entered.resolve();
      await release.promise;
    });
    await directoryCreated.promise;
    const secondAttempt = second.withCredentialLock(identity, 'refresh', async () => {});
    await ownerlessObserved.promise;
    allowOwnerWrite.resolve();
    await entered.promise;
    await assert.rejects(secondAttempt, (err) => err.code === 'credential_operation_busy');
    release.resolve();
    await firstAttempt;
  });

  it('reacquires when the initializer finishes and removes its lock during the ownerless wait', async () => {
    const root = makeRoot();
    const identity = 'c'.repeat(64);
    const directoryCreated = deferred();
    const allowOwnerWrite = deferred();
    const first = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        afterLockDirectoryCreated: async () => {
          directoryCreated.resolve();
          await allowOwnerWrite.promise;
        },
      } },
    });
    let firstAttempt;
    const second = new CredentialCoordinator({
      secretStore: new MemorySecretStore(),
      deps: { stateRoot: root, lockHooks: {
        ownerlessLockObserved: async () => {
          // Complete the first owner's whole operation before this contender
          // re-reads owner.json, reproducing mkdir->owner->remove in one gap.
          allowOwnerWrite.resolve();
          await firstAttempt;
        },
      } },
    });
    firstAttempt = first.withCredentialLock(identity, 'refresh', async () => {});
    await directoryCreated.promise;
    let secondEntered = false;
    await second.withCredentialLock(identity, 'refresh', async () => { secondEntered = true; });
    assert.equal(secondEntered, true, 'the missing canonical lock is acquired afresh');
  });

  it('retains a persistently ownerless lock for explicit stopped-process recovery', async () => {
    const root = makeRoot();
    const coordinator = new CredentialCoordinator({ secretStore: new MemorySecretStore(), deps: { stateRoot: root } });
    const identity = 'c'.repeat(64);
    const lock = path.join(root, `${require('node:crypto').createHash('sha256').update(identity).digest('hex')}.credential.lock`);
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    await assert.rejects(
      coordinator.withCredentialLock(identity, 'refresh', async () => {}),
      (err) => err.code === 'credential_recovery_interrupted'
    );
    assert.equal(fs.existsSync(lock), true, 'bounded ownerless retry never deletes an ambiguous lock');
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

  it('uses one config-commit lock when a first config file is named through a symlinked parent', async (t) => {
    const root = makeRoot();
    const realParent = path.join(root, 'real');
    const aliasParent = path.join(root, 'alias');
    fs.mkdirSync(realParent, { recursive: true });
    try {
      fs.symlinkSync(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('this Windows host does not permit test directory links');
        return;
      }
      throw err;
    }
    const aliasFile = path.join(aliasParent, 'wp-sites.json');
    const realFile = path.join(realParent, 'wp-sites.json');
    const first = new CredentialCoordinator({ secretStore: new MemorySecretStore(), configPath: aliasFile, siteId: 'site' });
    const second = new CredentialCoordinator({ secretStore: new MemorySecretStore(), configPath: realFile, siteId: 'site' });
    const entered = deferred();
    const release = deferred();
    const held = first.withConfigCommitLock('first-create', async ({ config, existed }) => {
      assert.equal(existed, false);
      config.sites = {};
      entered.resolve();
      await release.promise;
      return { write: true };
    }, { initialConfig: () => ({ schema_version: 2, sites: {} }) });
    await entered.promise;
    await assert.rejects(
      second.withConfigCommitLock('competing-first-create', async () => ({ write: false })),
      (err) => err.code === 'credential_operation_busy'
    );
    release.resolve();
    await held;
    assert.equal(fs.existsSync(realFile), true);
  });

  it('serializes a site authorization operation and reports reauth_in_progress to runtime readers', async () => {
    const root = makeRoot();
    const configPath = writeConfig(root, 'site', legacyAuth());
    const coordinator = new CredentialCoordinator({
      secretStore: new MemorySecretStore(), configPath, siteId: 'site', deps: { stateRoot: root },
    });
    const entered = deferred();
    const release = deferred();
    const authorization = coordinator.withAuthorizationLock('reauth', async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await assert.rejects(
      coordinator.readValidatedSnapshot({
        siteId: 'site', accessTokenRef: makeRef('abilities-mcp', 'site/access'),
        refreshTokenRef: makeRef('abilities-mcp', 'site/refresh'),
      }),
      (err) => err.code === 'reauth_in_progress'
    );
    release.resolve();
    await authorization;
  });

  it('refuses a simultaneous lock attempt from a second Node process', async () => {
    const root = makeRoot();
    const worker = path.join(__dirname, 'helpers', 'credential-lock-worker.js');
    const identity = 'b'.repeat(64);
    const startWorker = (holdMode) => {
      const child = spawn(process.execPath, [worker, root, identity, holdMode], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const closed = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      });
      child.stdout.on('data', (chunk) => { output += chunk; });
      return { child, closed, output: () => output };
    };
    const waitFor = async (workerProcess, text) => {
      const deadline = Date.now() + 5000;
      while (!workerProcess.output().includes(text)) {
        if (Date.now() >= deadline) throw new Error(`worker did not report ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const first = startWorker('stdin');
    try {
      await waitFor(first, 'locked');
      const second = startWorker('release');
      const secondResult = await second.closed;
      assert.equal(secondResult.code, 2);
      assert.match(secondResult.output, /error:credential_operation_busy/);
      first.child.stdin.end('release\n');
      const firstResult = await first.closed;
      assert.equal(firstResult.code, 0);
    } finally {
      if (!first.child.killed) first.child.kill();
      await first.closed.catch(() => {});
    }
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
    disk.sites.site.url = 'https://reauthorized.example.test';
    disk.sites.site.mcp_resource = 'https://reauthorized.example.test/wp-json/mcp/renewed';
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
    assert.equal(snapshot.siteUrl, 'https://reauthorized.example.test');
    assert.equal(snapshot.mcpResource, 'https://reauthorized.example.test/wp-json/mcp/renewed');
  });

  it('does not send a due externally adopted pair to the old token endpoint', async () => {
    const root = makeRoot();
    const store = new MemorySecretStore();
    const seed = new CredentialCoordinator({ secretStore: store, deps: { stateRoot: root } });
    const identity = 'f'.repeat(64);
    const oldPair = await seed.preparePair({
      credentialIdentity: identity, auth: { credential_pair_slot: 'b' },
      tokens: { access_token: 'AT-old', refresh_token: 'RT-old' },
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const newPair = await seed.preparePair({
      credentialIdentity: identity, auth: oldPair,
      tokens: { access_token: 'AT-new', refresh_token: 'RT-new' },
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const configPath = writeConfig(root, 'site', {
      method: 'oauth', client_id: 'old-client', ...oldPair,
    });
    let obsoleteEndpointRequests = 0;
    const obsoleteServer = http.createServer((_req, res) => {
      obsoleteEndpointRequests += 1;
      res.writeHead(500).end();
    });
    await new Promise((resolve, reject) => {
      obsoleteServer.once('error', reject);
      obsoleteServer.listen(0, '127.0.0.1', resolve);
    });
    const oldSiteUrl = `http://127.0.0.1:${obsoleteServer.address().port}`;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.sites.site.url = 'https://reauthorized.example.test';
      config.sites.site.mcp_resource = 'https://reauthorized.example.test/wp-json/mcp/renewed';
      Object.assign(config.sites.site.auth, { client_id: 'new-client', ...newPair });
      fs.writeFileSync(configPath, JSON.stringify(config));
      const coordinator = new CredentialCoordinator({ secretStore: store, configPath, siteId: 'site', deps: { stateRoot: root } });
      const tm = new TokenManager({ secretStore: store, allowInsecure: true, credentialCoordinator: coordinator });
      const cached = {
        siteId: 'site', siteUrl: oldSiteUrl, tokenEndpoint: `${oldSiteUrl}/oauth/token`,
        clientId: 'old-client', ...oldPair,
      };

      await assert.rejects(
        () => tm.getAccessToken(cached),
        (err) => err.code === 'token_endpoint_rediscovery_required'
      );
      await assert.rejects(
        () => tm.refresh(cached),
        (err) => err.code === 'token_endpoint_rediscovery_required'
      );
      assert.equal(obsoleteEndpointRequests, 0);
    } finally {
      await new Promise((resolve) => obsoleteServer.close(resolve));
    }
  });

  it('adopts a distinct reauthorization identity even when the cached legacy identity was refused elsewhere', async () => {
    const root = makeRoot();
    const store = new MemorySecretStore();
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    const seed = new CredentialCoordinator({ secretStore: store, deps: { stateRoot: root } });
    const oldPair = await seed.preparePair({ credentialIdentity: 'c'.repeat(64), auth: { credential_pair_slot: 'b' },
      tokens: { access_token: 'AT-old', refresh_token: 'RT-old' }, accessTokenExpiresAt: '2026-10-04T00:00:00.000Z' });
    const newPair = await seed.preparePair({ credentialIdentity: 'd'.repeat(64), auth: { credential_pair_slot: 'b' },
      tokens: { access_token: 'AT-new', refresh_token: 'RT-new' }, accessTokenExpiresAt: '2026-10-05T00:00:00.000Z' });
    const configA = writeConfig(path.join(root, 'a'), 'site-a', {
      method: 'oauth', credential_pair_ref: oldPair.credential_pair_ref, credential_generation: oldPair.credential_generation,
      credential_identity: oldPair.credential_identity, credential_pair_slot: oldPair.credential_pair_slot,
    });
    const configB = writeConfig(path.join(root, 'b'), 'site-b', {
      method: 'oauth', credential_pair_ref: oldPair.credential_pair_ref, credential_generation: oldPair.credential_generation,
      credential_identity: oldPair.credential_identity, credential_pair_slot: oldPair.credential_pair_slot,
    });
    const ownerA = new CredentialCoordinator({ secretStore: store, configPath: configA, siteId: 'site-a', deps: { stateRoot: root } });
    const processB = new CredentialCoordinator({ secretStore: store, configPath: configB, siteId: 'site-b', deps: { stateRoot: root } });
    await ownerA.claimOwnership(oldPair.credential_identity);
    await assert.rejects(processB.claimOwnership(oldPair.credential_identity), (err) => err.code === 'shared_credential_config_unsupported');

    const diskB = JSON.parse(fs.readFileSync(configB, 'utf8'));
    Object.assign(diskB.sites['site-b'].auth, {
      credential_pair_ref: newPair.credential_pair_ref, credential_generation: newPair.credential_generation,
      credential_identity: newPair.credential_identity, credential_pair_slot: newPair.credential_pair_slot,
    });
    fs.writeFileSync(configB, JSON.stringify(diskB));
    const adopted = await processB.readValidatedSnapshot({
      siteId: 'site-b', credentialPairRef: oldPair.credential_pair_ref,
      credentialGeneration: oldPair.credential_generation, credentialIdentity: oldPair.credential_identity,
      credentialPairSlot: oldPair.credential_pair_slot,
    });
    assert.equal(adopted.credentialIdentity, newPair.credential_identity);
    assert.equal(adopted._accessToken, 'AT-new');
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

  it('clears a newly-created proven-unsent marker so a reconstructed manager can refresh later', async () => {
    const root = makeRoot();
    const now = Date.parse('2026-10-29T00:00:00.000Z');
    const { store, configPath, coordinator, siteAuth } = await configuredPairFixture(root, now);
    const dnsFailure = () => Object.assign(new Error('temporary DNS failure'), {
      code: 'EAI_AGAIN', oauthDelivery: 'proven_not_dispatched',
    });
    const first = new TokenManager({
      secretStore: store, credentialCoordinator: coordinator,
      deps: { now: () => now, sleep: async () => {}, postForm: async () => { throw dnsFailure(); } },
    });
    const retained = await first.getAccessToken(siteAuth);
    assert.equal(retained.accessToken, 'AT-old');
    assert.equal(retained.refreshDeferred, true);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites.site.auth.refresh_attempt, undefined);

    const restartedCoordinator = new CredentialCoordinator({
      secretStore: store, configPath, siteId: 'site', deps: { stateRoot: root, now: () => now },
    });
    const restarted = new TokenManager({
      secretStore: store, credentialCoordinator: restartedCoordinator,
      deps: {
        now: () => now, sleep: async () => {},
        postForm: async () => ({ statusCode: 200, json: {
          access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600,
        } }),
      },
    });
    const refreshed = await restarted.getAccessToken(siteAuth);
    assert.equal(refreshed.accessToken, 'AT-new');
  });

  it('fails closed and retains the marker when proven-unsent cleanup cannot persist', async () => {
    const root = makeRoot();
    const now = Date.parse('2026-10-29T00:00:00.000Z');
    const { store, configPath, coordinator, siteAuth } = await configuredPairFixture(root, now);
    const originalCommit = coordinator.withConfigCommitLock.bind(coordinator);
    coordinator.withConfigCommitLock = (operation, fn, opts) => {
      if (operation === 'clear-proven-unsent-refresh') {
        throw new RefreshError('simulated config persistence failure', {
          code: 'credential_config_unavailable', state: 'refreshing',
        });
      }
      return originalCommit(operation, fn, opts);
    };
    const tm = new TokenManager({
      secretStore: store, credentialCoordinator: coordinator,
      deps: {
        now: () => now, sleep: async () => {},
        postForm: async () => { throw Object.assign(new Error('temporary DNS failure'), {
          code: 'EAI_AGAIN', oauthDelivery: 'proven_not_dispatched',
        }); },
      },
    });
    await assert.rejects(tm.getAccessToken(siteAuth), (err) => err.code === 'credential_config_unavailable');
    assert.ok(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites.site.auth.refresh_attempt,
      'a cleanup failure leaves the marker for fail-closed recovery');
  });

  it('never clears an abandoned marker from an earlier invocation', async () => {
    const root = makeRoot();
    const now = Date.parse('2026-10-29T00:00:00.000Z');
    const { store, configPath, coordinator, siteAuth } = await configuredPairFixture(root, now);
    const abandoned = await coordinator.beginRefresh(siteAuth);
    const tm = new TokenManager({
      secretStore: store, credentialCoordinator: coordinator,
      deps: {
        now: () => now, sleep: async () => {},
        postForm: async () => { throw Object.assign(new Error('temporary DNS failure'), {
          code: 'EAI_AGAIN', oauthDelivery: 'proven_not_dispatched',
        }); },
      },
    });
    await assert.rejects(
      tm.getAccessToken(siteAuth),
      (err) => err.code === 'network_error' && err.refreshDelivery === 'unknown'
    );
    const marker = JSON.parse(fs.readFileSync(configPath, 'utf8')).sites.site.auth.refresh_attempt;
    assert.equal(marker.nonce, abandoned.nonce);
    assert.equal(marker.attempt_count, 2);
  });

  it('does not clear a marker after concurrent reauthorization changes its identity and generation', async () => {
    const root = makeRoot();
    const now = Date.parse('2026-10-29T00:00:00.000Z');
    const { configPath, coordinator, siteAuth } = await configuredPairFixture(root, now);
    const marker = await coordinator.beginRefresh(siteAuth);
    await coordinator.recordRefreshAttempt(marker);
    await coordinator.recordRefreshAttempt(marker);
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    disk.sites.site.auth.client_id = 'client-after-reauth';
    disk.sites.site.auth.credential_identity = 'f'.repeat(64);
    disk.sites.site.auth.credential_generation = 'replacement-generation';
    fs.writeFileSync(configPath, JSON.stringify(disk));
    await assert.rejects(
      coordinator.clearProvenUnsentRefresh(marker, siteAuth, 2),
      (err) => err.code === 'unknown_refresh_outcome'
    );
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites.site.auth.refresh_attempt.nonce, marker.nonce);
  });

  it('retains the marker after a received 5xx then a proven-unsent DNS failure', async () => {
    const root = makeRoot();
    const now = Date.parse('2026-10-29T00:00:00.000Z');
    const { store, configPath, coordinator, siteAuth } = await configuredPairFixture(root, now);
    let attempts = 0;
    const tm = new TokenManager({
      secretStore: store, credentialCoordinator: coordinator,
      deps: {
        now: () => now, sleep: async () => {},
        postForm: async () => {
          attempts += 1;
          if (attempts === 1) return { statusCode: 503, body: '', json: null };
          throw Object.assign(new Error('temporary DNS failure'), {
            code: 'EAI_AGAIN', oauthDelivery: 'proven_not_dispatched',
          });
        },
      },
    });
    await assert.rejects(
      tm.getAccessToken(siteAuth),
      (err) => err.code === 'network_error' && err.refreshDelivery === 'unknown'
    );
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).sites.site.auth.refresh_attempt.attempt_count, 2);
  });
});
