'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { migrateConfig, migrateFile, isV2 } = require('../../lib/auth/config-migration');
const { validate, SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { CredentialCoordinator } = require('../../lib/auth/credential-coordinator');

function tmpFile() {
  return path.join(os.tmpdir(), `wp-sites-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function tmpConfigRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-migration-'));
}

function legacyConfig() {
  return {
    defaultSite: 'one',
    sites: {
      one: { url: 'https://one.example', transport: 'http', http: { endpoint: 'https://one.example/mcp', username: 'one', password: 'one-secret' } },
      two: { url: 'https://two.example', transport: 'http', http: { endpoint: 'https://two.example/mcp', username: 'two', password: 'two-secret' } },
    },
  };
}

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

function busyError() {
  const error = new Error('credential operation busy');
  error.code = 'credential_operation_busy';
  return error;
}

class CountingStore extends MemorySecretStore {
  constructor(onSet = null) {
    super();
    this.sets = 0;
    this.onSet = onSet;
  }

  async set(...args) {
    this.sets += 1;
    if (this.onSet) await this.onSet(this.sets);
    return super.set(...args);
  }
}

describe('config-migration.migrateConfig', () => {
  it('migrates a transport:http site with plaintext password', async () => {
    const legacy = {
      defaultSite: 'mysite',
      sites: {
        mysite: {
          label: 'My Site',
          url: 'https://example.com',
          transport: 'http',
          http: { endpoint: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server', username: 'u', password: 'P' },
        },
      },
    };
    const store = new MemorySecretStore();
    const { config, lifted } = await migrateConfig(legacy, { secretStore: store });

    assert.equal(config.schema_version, SCHEMA_VERSION);
    assert.equal(config.defaultSite, 'mysite');

    const site = config.sites.mysite;
    assert.equal(site.auth.method, 'apppassword');
    assert.equal(site.auth.username, 'u');
    assert.match(site.auth.password_ref, /^keychain:\/\/abilities-mcp\/mysite\/apppassword$/);
    assert.equal(site.auth_status, 'active');

    // Plaintext password lifted into store
    assert.equal(await store.get('abilities-mcp', 'mysite/apppassword'), 'P');
    // Plaintext password removed from http block
    assert.equal(site.http.password, undefined);
    assert.equal(site.http.password_ref, site.auth.password_ref);

    // Validates clean against v2 schema
    assert.deepEqual(validate(config), { ok: true });
    assert.equal(lifted.length, 1);
  });

  it('migrates a transport:http site with passwordEnv', async () => {
    const legacy = {
      sites: {
        mysite: {
          url: 'https://example.com',
          transport: 'http',
          http: { endpoint: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server', username: 'u', passwordEnv: 'WP_PW' },
        },
      },
    };
    const store = new MemorySecretStore();
    const { config } = await migrateConfig(legacy, { secretStore: store, env: { WP_PW: 'env-secret' } });
    assert.equal(await store.get('abilities-mcp', 'mysite/apppassword'), 'env-secret');
    assert.deepEqual(validate(config), { ok: true });
  });

  it('preserves ssh transport sites and tags them apppassword', async () => {
    const legacy = {
      sites: {
        sshsite: {
          transport: 'ssh',
          ssh: { host: 'h', path: '/p', user: 'u' },
        },
      },
    };
    const store = new MemorySecretStore();
    const { config } = await migrateConfig(legacy, { secretStore: store });
    const site = config.sites.sshsite;
    assert.equal(site.transport, 'ssh');             // preserved
    assert.deepEqual(site.ssh, { host: 'h', path: '/p', user: 'u' });
    assert.equal(site.auth.method, 'apppassword');   // synthetic
    assert.equal(site.auth.username, 'u');
    assert.deepEqual(validate(config), { ok: true });
  });

  it('errs cleanly when passwordEnv is missing from the env', async () => {
    const legacy = {
      sites: {
        mysite: {
          url: 'https://example.com',
          transport: 'http',
          http: { endpoint: 'https://example.com/x', username: 'u', passwordEnv: 'WP_PW' },
        },
      },
    };
    await assert.rejects(
      migrateConfig(legacy, { secretStore: new MemorySecretStore(), env: {} }),
      /WP_PW.*not set/
    );
  });
});

describe('config-migration.migrateFile', () => {
  it('writes v2 atomically and creates .v1.bak', async () => {
    const file = tmpFile();
    const legacy = {
      defaultSite: 'mysite',
      sites: {
        mysite: {
          url: 'https://example.com',
          transport: 'http',
          http: { endpoint: 'https://example.com/x', username: 'u', password: 'P' },
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));

    const store = new MemorySecretStore();
    const result = await migrateFile({ filePath: file, secretStore: store });

    assert.equal(result.migrated, true);
    assert.equal(result.backupPath, `${file}.v1.bak`);
    assert.equal(result.liftedCount, 1);

    // Backup matches original byte-for-byte
    const original = JSON.stringify(legacy, null, 2);
    const backup = fs.readFileSync(`${file}.v1.bak`, 'utf8');
    assert.equal(backup, original);

    // New file is v2 + valid
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(isV2(written), true);
    assert.deepEqual(validate(written), { ok: true });

    fs.unlinkSync(file);
    fs.unlinkSync(`${file}.v1.bak`);
  });

  it('is idempotent — running again on a v2 file is a no-op', async () => {
    const file = tmpFile();
    const v2 = {
      schema_version: 2,
      sites: {
        siteA: {
          url: 'https://siteA.com',
          auth: { method: 'apppassword', username: 'u', password_ref: 'keychain://abilities-mcp/siteA/apppassword' },
          auth_status: 'active',
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(v2, null, 2));

    const store = new MemorySecretStore();
    const result = await migrateFile({ filePath: file, secretStore: store });

    assert.equal(result.migrated, false);
    assert.equal(result.alreadyV2, true);
    assert.equal(fs.existsSync(`${file}.v1.bak`), false);

    fs.unlinkSync(file);
  });

  it('returns missing=true when file does not exist (clean install)', async () => {
    const result = await migrateFile({
      filePath: tmpFile(),
      secretStore: new MemorySecretStore(),
    });
    assert.equal(result.migrated, false);
    assert.equal(result.missing, true);
  });

  it('dryRun does not write or back up', async () => {
    const file = tmpFile();
    const legacy = {
      sites: {
        mysite: {
          url: 'https://example.com',
          transport: 'http',
          http: { endpoint: 'https://example.com/x', username: 'u', password: 'P' },
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));

    const store = new MemorySecretStore();
    const result = await migrateFile({ filePath: file, secretStore: store, dryRun: true });
    assert.equal(result.migrated, false);
    assert.equal(result.previewConfig.schema_version, SCHEMA_VERSION);
    assert.equal(fs.existsSync(`${file}.v1.bak`), false);

    // Original still on disk untouched
    const stillThere = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stillThere.sites.mysite.transport, 'http');

    fs.unlinkSync(file);
  });

  it('serializes concurrent migration attempts without dropping legacy sites', async () => {
    const file = tmpFile();
    const legacy = {
      defaultSite: 'one',
      sites: {
        one: { url: 'https://one.example', transport: 'http', http: { endpoint: 'https://one.example/x', username: 'u1', password: 'P1' } },
        two: { url: 'https://two.example', transport: 'http', http: { endpoint: 'https://two.example/x', username: 'u2', password: 'P2' } },
      },
    };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    const store = new MemorySecretStore();

    const results = await Promise.all([
      migrateFile({ filePath: file, secretStore: store }),
      migrateFile({ filePath: file, secretStore: store }),
    ]);

    assert.equal(results.filter((result) => result.migrated).length, 1);
    assert.equal(results.filter((result) => result.alreadyV2).length, 1);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(written.sites).sort(), ['one', 'two']);
    fs.unlinkSync(file);
    fs.unlinkSync(`${file}.v1.bak`);
  });

  it('reuses a fully committed v2 config while the first migration release is still held', async () => {
    const root = tmpConfigRoot();
    const file = path.join(root, 'wp-sites.json');
    fs.writeFileSync(file, JSON.stringify(legacyConfig(), null, 2));
    const store = new CountingStore();
    const originalRelease = CredentialCoordinator.prototype._releaseOwnedLock;
    const retired = deferred();
    const allowRelease = deferred();
    let held = false;
    CredentialCoordinator.prototype._releaseOwnedLock = async function heldRelease(...args) {
      if (!held) {
        held = true;
        retired.resolve();
        await allowRelease.promise;
      }
      return originalRelease.apply(this, args);
    };
    try {
      const first = migrateFile({ filePath: file, secretStore: store });
      await retired.promise;
      const second = await migrateFile({ filePath: file, secretStore: store });
      const published = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(second, { migrated: false, alreadyV2: true, filePath: file });
      assert.equal(store.sets, 2, 'the contender does not lift secrets again');
      assert.equal(published.defaultSite, 'one');
      assert.deepEqual(Object.keys(published.sites).sort(), ['one', 'two']);
      assert.equal(published.sites.one.auth.password_ref, 'keychain://abilities-mcp/one/apppassword');
      assert.equal(published.sites.one.http.password_ref, published.sites.one.auth.password_ref);
      assert.equal(fs.existsSync(`${file}.v1.bak`), true);
      allowRelease.resolve();
      assert.equal((await first).migrated, true);
    } finally {
      allowRelease.resolve();
      CredentialCoordinator.prototype._releaseOwnedLock = originalRelease;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses a fully committed v2 config when canonical release rename fails', async () => {
    const root = tmpConfigRoot();
    const file = path.join(root, 'wp-sites.json');
    fs.writeFileSync(file, JSON.stringify(legacyConfig(), null, 2));
    const store = new CountingStore();
    const originalRename = fs.promises.rename;
    let injected = false;
    fs.promises.rename = async (from, to) => {
      if (!injected && String(from).endsWith('.config.lock') && String(to).includes('.config.lock.released.')) {
        injected = true;
        const error = new Error('simulated release rename failure');
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(from, to);
    };
    try {
      const first = await migrateFile({ filePath: file, secretStore: store });
      const second = await migrateFile({ filePath: file, secretStore: store });
      assert.equal(injected, true);
      assert.equal(first.migrated, true);
      assert.deepEqual(second, { migrated: false, alreadyV2: true, filePath: file });
      assert.equal(store.sets, 2, 'the busy contender does not duplicate secret writes');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schema_version, SCHEMA_VERSION);
    } finally {
      fs.promises.rename = originalRename;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reuse a busy migration before v2 publication completes', async () => {
    const root = tmpConfigRoot();
    const file = path.join(root, 'wp-sites.json');
    fs.writeFileSync(file, JSON.stringify(legacyConfig(), null, 2));
    const entered = deferred();
    const allowSet = deferred();
    let held = false;
    const store = new CountingStore(async () => {
      if (!held) {
        held = true;
        entered.resolve();
        await allowSet.promise;
      }
    });
    try {
      const first = migrateFile({ filePath: file, secretStore: store });
      await entered.promise;
      await assert.rejects(
        migrateFile({ filePath: file, secretStore: store }),
        (error) => error.code === 'write_failed' && error.cause && error.cause.code === 'credential_operation_busy'
      );
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schema_version, undefined);
      assert.equal(store.sets, 1, 'the waiting contender does not write a second secret');
      allowSet.resolve();
      assert.equal((await first).migrated, true);
    } finally {
      allowSet.resolve();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat malformed, version-only, or array v2-shaped files as a completed busy migration', async () => {
    const root = tmpConfigRoot();
    const file = path.join(root, 'wp-sites.json');
    const originalCommit = CredentialCoordinator.prototype.withConfigCommitLock;
    CredentialCoordinator.prototype.withConfigCommitLock = async () => { throw busyError(); };
    try {
      for (const raw of ['{', JSON.stringify({ schema_version: SCHEMA_VERSION }), JSON.stringify({ schema_version: SCHEMA_VERSION, sites: [] })]) {
        fs.writeFileSync(file, raw);
        await assert.rejects(
          migrateFile({ filePath: file, secretStore: new CountingStore() }),
          (error) => error.code === 'write_failed' && error.cause && error.cause.code === 'credential_operation_busy'
        );
      }
      const missing = path.join(root, 'missing.json');
      assert.deepEqual(
        await migrateFile({ filePath: missing, secretStore: new CountingStore() }),
        { migrated: false, alreadyV2: false, filePath: missing, missing: true }
      );
    } finally {
      CredentialCoordinator.prototype.withConfigCommitLock = originalCommit;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an ownerless config lock fail-closed even when the file is valid v2', async (t) => {
    const root = tmpConfigRoot();
    const file = path.join(root, 'wp-sites.json');
    const v2 = {
      schema_version: SCHEMA_VERSION,
      sites: {
        site: {
          url: 'https://site.example',
          auth: { method: 'apppassword', username: 'site', password_ref: 'keychain://abilities-mcp/site/apppassword' },
          auth_status: 'active',
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(v2));
    // Use the same existing-file canonicalization that withConfigCommitLock()
    // uses before it hashes the config path. On Windows, realpathSync() and
    // fs.promises.realpath() can spell an existing path differently.
    const realPath = path.join(await fs.promises.realpath(path.resolve(file)));
    const lock = path.join(path.dirname(realPath), '.abilities-mcp-coordination',
      `${crypto.createHash('sha256').update(realPath).digest('hex')}.config.lock`);
    const legacySyncPath = fs.realpathSync(file);
    const legacySyncLock = path.join(path.dirname(legacySyncPath), '.abilities-mcp-coordination',
      `${crypto.createHash('sha256').update(legacySyncPath).digest('hex')}.config.lock`);
    const originalConfigBytes = fs.readFileSync(file);
    const store = new CountingStore();
    const originalWithLock = CredentialCoordinator.prototype._withLock;
    let observedLockPath = null;
    let withLockCalls = 0;
    CredentialCoordinator.prototype._withLock = function observeConfigLock(lockPath, ...args) {
      observedLockPath = lockPath;
      withLockCalls += 1;
      return originalWithLock.call(this, lockPath, ...args);
    };
    try {
      fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
      await assert.rejects(
        migrateFile({ filePath: file, secretStore: store }),
        (error) => error.code === 'write_failed' && error.cause && error.cause.code === 'credential_recovery_interrupted'
      );
      assert.equal(withLockCalls, 1, 'migration attempts the config lock once');
      assert.equal(observedLockPath, lock, 'fixture blocks the production-derived config lock target');
      assert.deepEqual(fs.readFileSync(file), originalConfigBytes, 'the valid v2 config remains unchanged');
      assert.deepEqual(fs.readdirSync(lock), [], 'the ownerless lock remains untouched');
      assert.equal(store.sets, 0, 'the blocked migration writes no secrets');
      assert.equal(fs.existsSync(`${file}.v1.bak`), false, 'the blocked migration creates no backup');
      if (legacySyncLock !== lock) {
        t.diagnostic(`ownerless_lock_canonicalization legacy_sha256=${crypto.createHash('sha256').update(legacySyncLock).digest('hex')} production_sha256=${crypto.createHash('sha256').update(lock).digest('hex')}`);
      }
    } finally {
      CredentialCoordinator.prototype._withLock = originalWithLock;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
