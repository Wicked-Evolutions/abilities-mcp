'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { migrateConfig, migrateFile, isV2 } = require('../../lib/auth/config-migration');
const { validate, SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');

function tmpFile() {
  return path.join(os.tmpdir(), `wp-sites-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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
          http: { endpoint: 'https://example.com/wp-json/mcp/mcp-adapter-default-server', username: 'u', password: 'P' },
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
          http: { endpoint: 'https://example.com/wp-json/mcp/mcp-adapter-default-server', username: 'u', passwordEnv: 'WP_PW' },
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
});
