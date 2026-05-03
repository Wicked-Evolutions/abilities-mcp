'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { seedFromEnvIfMissing, deriveSiteId, readConfig } = require('../../lib/cli/config-store');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { SECRET_SERVICE } = require('../../lib/auth/token-manager');
const { validate, SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { validateSiteConfig } = require('../../lib/config');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-seed-'));
  tmpDirs.push(d);
  return d;
}

function defaultEnv(overrides = {}) {
  return {
    ABILITIES_MCP_URL: 'https://wickedevolutions.com',
    ABILITIES_MCP_USERNAME: 'wicked',
    ABILITIES_MCP_PASSWORD: 'app pwd 1234',
    ...overrides,
  };
}

describe('seedFromEnvIfMissing — happy path (Issue #34)', () => {
  it('writes a v2 apppassword entry when wp-sites.json does not exist', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');
    const store = new MemorySecretStore();

    const result = await seedFromEnvIfMissing(configPath, defaultEnv(), { secretStore: store });
    assert.equal(result.seeded, true);
    assert.equal(result.siteId, 'wickedevolutions');
    assert.equal(result.configPath, configPath);

    // File exists, parses, and the v2 entry is shaped per F.5.
    const written = readConfig(configPath);
    assert.equal(written.schema_version, SCHEMA_VERSION);
    assert.equal(written.defaultSite, 'wickedevolutions');
    const site = written.sites.wickedevolutions;
    assert.equal(site.url, 'https://wickedevolutions.com');
    assert.equal(site.label, 'wickedevolutions.com');
    assert.equal(site.transport, 'http');
    assert.equal(site.http.endpoint, 'https://wickedevolutions.com/wp-json/mcp/mcp-adapter-default-server');
    assert.equal(site.http.username, 'wicked');
    assert.equal(site.http.password_ref, `keychain://${SECRET_SERVICE}/wickedevolutions/apppassword`);
    assert.equal(site.auth.method, 'apppassword');
    assert.equal(site.auth.username, 'wicked');
    assert.equal(site.auth.password_ref, `keychain://${SECRET_SERVICE}/wickedevolutions/apppassword`);
    assert.equal(site.auth_status, 'active');
  });

  it('the password is in the keychain at the documented account path', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');
    const store = new MemorySecretStore();

    await seedFromEnvIfMissing(configPath, defaultEnv(), { secretStore: store });

    const stored = await store.get(SECRET_SERVICE, 'wickedevolutions/apppassword');
    assert.equal(stored, 'app pwd 1234');
  });

  it('seeded entry passes schema-v2 validate()', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');
    const store = new MemorySecretStore();

    await seedFromEnvIfMissing(configPath, defaultEnv(), { secretStore: store });

    const written = readConfig(configPath);
    const v = validate(written);
    assert.equal(v.ok, true, v.ok ? '' : v.errors.join('\n'));
  });

  it('seeded entry passes the bridge runtime validateSiteConfig (apppassword/http branch)', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');
    const store = new MemorySecretStore();

    await seedFromEnvIfMissing(configPath, defaultEnv(), { secretStore: store });

    const written = readConfig(configPath);
    const site = written.sites.wickedevolutions;
    // Should not throw.
    await validateSiteConfig('wickedevolutions', site);
  });
});

describe('seedFromEnvIfMissing — guards', () => {
  it('is a no-op when wp-sites.json already exists', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');
    fs.writeFileSync(configPath, '{"schema_version":2,"defaultSite":"x","sites":{"x":{}}}', { mode: 0o600 });
    const store = new MemorySecretStore();

    const before = fs.readFileSync(configPath, 'utf8');
    const result = await seedFromEnvIfMissing(configPath, defaultEnv(), { secretStore: store });
    const after = fs.readFileSync(configPath, 'utf8');

    assert.equal(result.seeded, false);
    assert.equal(result.reason, 'exists');
    assert.equal(before, after, 'pre-existing wp-sites.json must not be overwritten');
    // No keychain write either — operator may already manage their own.
    const found = await store.get(SECRET_SERVICE, 'wickedevolutions/apppassword');
    assert.equal(found, null);
  });

  it('skips seeding when keytar is unavailable (graceful degradation)', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');

    // Stub a SecretStore whose isAvailable resolves false — mimics a .mcpb
    // bundle that somehow shipped without the bundled keytar binary, or a
    // CLI install on a platform where keytar's native build failed.
    const fakeStore = {
      isAvailable: async () => false,
      set: async () => { throw new Error('should not be called'); },
      get: async () => null,
      delete: async () => false,
    };

    const result = await seedFromEnvIfMissing(configPath, defaultEnv(), { secretStore: fakeStore });
    assert.equal(result.seeded, false);
    assert.equal(result.reason, 'keytar-unavailable');
    assert.equal(fs.existsSync(configPath), false, 'no file written when keychain is unavailable');
  });

  it('skips seeding when env vars are missing', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');
    const store = new MemorySecretStore();

    const cases = [
      {},
      { ABILITIES_MCP_URL: 'https://x.com' },
      { ABILITIES_MCP_URL: 'https://x.com', ABILITIES_MCP_USERNAME: 'u' },
      { ABILITIES_MCP_USERNAME: 'u', ABILITIES_MCP_PASSWORD: 'p' },
    ];
    for (const env of cases) {
      const result = await seedFromEnvIfMissing(configPath, env, { secretStore: store });
      assert.equal(result.seeded, false);
      assert.equal(result.reason, 'missing-env-vars');
    }
    assert.equal(fs.existsSync(configPath), false);
  });

  it('skips seeding when ABILITIES_MCP_URL is malformed', async () => {
    const dir = freshTmpDir();
    const configPath = path.join(dir, 'wp-sites.json');
    const store = new MemorySecretStore();

    const result = await seedFromEnvIfMissing(
      configPath,
      defaultEnv({ ABILITIES_MCP_URL: 'not-a-valid-url' }),
      { secretStore: store }
    );
    assert.equal(result.seeded, false);
    assert.equal(result.reason, 'invalid-url');
    assert.equal(fs.existsSync(configPath), false);
  });

  it('rolls back the keychain write when the file write fails', async () => {
    const dir = freshTmpDir();
    // Plant a regular file at the parent component so mkdir -p / atomicWrite
    // fails with ENOTDIR portably across macOS / Linux / Windows.
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'I am a regular file', { mode: 0o644 });
    const configPath = path.join(blocker, 'wp-sites.json');
    const store = new MemorySecretStore();

    const result = await seedFromEnvIfMissing(configPath, defaultEnv(), { secretStore: store });
    assert.equal(result.seeded, false);
    assert.equal(result.reason, 'error');
    assert.ok(result.error instanceof Error);
    // Keychain entry was rolled back — no orphan secret.
    const found = await store.get(SECRET_SERVICE, 'wickedevolutions/apppassword');
    assert.equal(found, null);
  });
});

describe('deriveSiteId', () => {
  it('strips the TLD off a hostname', () => {
    assert.equal(deriveSiteId('https://wickedevolutions.com'), 'wickedevolutions');
    assert.equal(deriveSiteId('https://helenawillow.com'), 'helenawillow');
  });

  it('strips a leading www.', () => {
    assert.equal(deriveSiteId('https://www.example.com'), 'example');
  });

  it('returns the hostname when there is no dot', () => {
    assert.equal(deriveSiteId('https://localhost'), 'localhost');
  });

  it('returns null for unparseable URLs', () => {
    assert.equal(deriveSiteId('not-a-url'), null);
    assert.equal(deriveSiteId(''), null);
  });
});
