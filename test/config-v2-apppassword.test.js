'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, resolveSitePassword } = require('../lib/config');
const { MemorySecretStore } = require('../lib/auth/memory-secret-store');
const { makeRef } = require('../lib/auth/secret-store');
const { SECRET_SERVICE } = require('../lib/auth/token-manager');

/**
 * Issue #26 — post-migration v2 apppassword sites must validate successfully
 * and the runtime resolver must read the secret from keychain via
 * auth.password_ref. The migration strips legacy http.password* fields per
 * F.5, so any validator path that still requires one of them is a regression.
 */

const tmpFiles = [];
after(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

function writeTempConfig(contents) {
  const file = path.join(
    os.tmpdir(),
    `wp-sites.test.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 });
  tmpFiles.push(file);
  return file;
}

describe('loadConfig — v2 apppassword site acceptance (Issue #26)', () => {
  it('accepts an apppassword/http site with auth.password_ref and no legacy http.password', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'wicked',
      sites: {
        wicked: {
          url: 'https://wickedevolutions.com',
          transport: 'http',
          http: {
            endpoint: 'https://wickedevolutions.com/wp-json/mcp/abilities-mcp-adapter-default-server',
            username: 'wicked_user',
            password_ref: makeRef(SECRET_SERVICE, 'wicked/apppassword'),
          },
          auth: {
            method: 'apppassword',
            username: 'wicked_user',
            password_ref: makeRef(SECRET_SERVICE, 'wicked/apppassword'),
          },
          auth_status: 'active',
        },
      },
    });
    const cfg = await loadConfig({ config: file });
    assert.equal(cfg.sites.wicked.auth.method, 'apppassword');
  });

  it('accepts an apppassword/ssh carrier site (no http block)', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'sshc',
      sites: {
        sshc: {
          url: 'ssh://shared.example',
          transport: 'ssh',
          ssh: { host: 'shared.example', path: '/var/www/wp', user: 'deploy' },
          auth: {
            method: 'apppassword',
            username: 'deploy',
            password_ref: makeRef(SECRET_SERVICE, 'sshc/apppassword'),
          },
          auth_status: 'active',
        },
      },
    });
    const cfg = await loadConfig({ config: file });
    assert.equal(cfg.sites.sshc.transport, 'ssh');
  });

  it('rejects an apppassword site missing auth.username', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'x',
      sites: {
        x: {
          url: 'https://x.example',
          transport: 'http',
          http: { endpoint: 'https://x.example/wp-json/mcp/abilities-mcp-adapter-default-server', username: 'u' },
          auth: { method: 'apppassword', password_ref: makeRef(SECRET_SERVICE, 'x/apppassword') },
        },
      },
    });
    await assert.rejects(loadConfig({ config: file }), /auth\.username/);
  });

  it('rejects an apppassword site missing auth.password_ref', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'x',
      sites: {
        x: {
          url: 'https://x.example',
          transport: 'http',
          http: { endpoint: 'https://x.example/wp-json/mcp/abilities-mcp-adapter-default-server', username: 'u' },
          auth: { method: 'apppassword', username: 'u' },
        },
      },
    });
    await assert.rejects(loadConfig({ config: file }), /password_ref/);
  });

  it('rejects an apppassword/http site missing http.endpoint', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'x',
      sites: {
        x: {
          url: 'https://x.example',
          transport: 'http',
          http: { username: 'u' },
          auth: {
            method: 'apppassword',
            username: 'u',
            password_ref: makeRef(SECRET_SERVICE, 'x/apppassword'),
          },
        },
      },
    });
    await assert.rejects(loadConfig({ config: file }), /http\.endpoint/);
  });

  it('rejects an apppassword/ssh site missing ssh.host or ssh.path', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'x',
      sites: {
        x: {
          url: 'ssh://x',
          transport: 'ssh',
          ssh: { host: 'x' },
          auth: {
            method: 'apppassword',
            username: 'u',
            password_ref: makeRef(SECRET_SERVICE, 'x/apppassword'),
          },
        },
      },
    });
    await assert.rejects(loadConfig({ config: file }), /ssh\.host and ssh\.path/);
  });

  it('rejects an apppassword/http site whose endpoint is HTTP without allowInsecure', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'x',
      sites: {
        x: {
          url: 'http://x.example',
          transport: 'http',
          http: { endpoint: 'http://x.example/wp-json/mcp/abilities-mcp-adapter-default-server', username: 'u' },
          auth: {
            method: 'apppassword',
            username: 'u',
            password_ref: makeRef(SECRET_SERVICE, 'x/apppassword'),
          },
        },
      },
    });
    await assert.rejects(loadConfig({ config: file }), /not HTTPS/);
  });

  it('still accepts a legacy v1 apppassword shape (no auth block) — no regression', async () => {
    const file = writeTempConfig({
      defaultSite: 'legacy',
      sites: {
        legacy: {
          url: 'https://legacy.example',
          transport: 'http',
          http: {
            endpoint: 'https://legacy.example/wp-json/mcp/abilities-mcp-adapter-default-server',
            username: 'u',
            password: 'pw',
          },
        },
      },
    });
    const cfg = await loadConfig({ config: file });
    assert.equal(cfg.sites.legacy.http.password, 'pw');
  });
});

describe('resolveSitePassword (Issue #26)', () => {
  it('reads the secret from the SecretStore for v2 apppassword sites', async () => {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/apppassword', 'topsecret');
    const site = {
      transport: 'http',
      http: { endpoint: 'https://x', username: 'u' },
      auth: {
        method: 'apppassword',
        username: 'u',
        password_ref: makeRef(SECRET_SERVICE, 'siteA/apppassword'),
      },
    };
    const pw = await resolveSitePassword(site, store);
    assert.equal(pw, 'topsecret');
  });

  it('falls back to the legacy http.password resolver for v1 sites with no auth block', async () => {
    const site = {
      transport: 'http',
      http: { endpoint: 'https://x', username: 'u', password: 'plain' },
    };
    const pw = await resolveSitePassword(site, null);
    assert.equal(pw, 'plain');
  });

  it('throws a clear error when the keychain reference is missing in the store', async () => {
    const store = new MemorySecretStore();
    const site = {
      transport: 'http',
      http: { endpoint: 'https://x', username: 'u' },
      auth: {
        method: 'apppassword',
        username: 'u',
        password_ref: makeRef(SECRET_SERVICE, 'missing/apppassword'),
      },
    };
    await assert.rejects(
      resolveSitePassword(site, store),
      /Keychain reference not found/,
    );
  });
});
