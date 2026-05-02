'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../lib/config');

/**
 * The runtime config loader must accept v2 OAuth sites (which carry no
 * `transport` block, only `auth.method === 'oauth'` + `mcp_resource`). This
 * is the gating change for Issue #17 — without it, the bridge cannot even
 * boot when its config contains an OAuth site.
 */

const tmpFiles = [];
after(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

function writeTempConfig(contents) {
  const file = path.join(os.tmpdir(), `wp-sites.test.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 });
  tmpFiles.push(file);
  return file;
}

describe('loadConfig — v2 OAuth site acceptance (Issue #17 gating change)', () => {
  it('accepts an OAuth site with mcp_resource and no transport block', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          mcp_resource: 'https://example.com/wp-json/mcp/mcp-adapter-default-server',
          auth: {
            method: 'oauth',
            client_id: 'client-x',
            access_token_ref: 'keychain://abilities-mcp/siteA/access',
            refresh_token_ref: 'keychain://abilities-mcp/siteA/refresh',
          },
          auth_status: 'active',
        },
      },
    });
    const cfg = await loadConfig({ config: file });
    assert.equal(cfg.defaultSite, 'siteA');
    assert.equal(cfg.sites.siteA.auth.method, 'oauth');
  });

  it('rejects an OAuth site that is missing mcp_resource', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          auth: {
            method: 'oauth',
            client_id: 'x',
            access_token_ref: 'keychain://abilities-mcp/siteA/access',
            refresh_token_ref: 'keychain://abilities-mcp/siteA/refresh',
          },
          auth_status: 'active',
        },
      },
    });
    await assert.rejects(loadConfig({ config: file }), /mcp_resource/);
  });

  it('rejects an OAuth site whose mcp_resource is HTTP without allowInsecure', async () => {
    const file = writeTempConfig({
      schema_version: 2,
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'http://example.com',
          mcp_resource: 'http://example.com/wp-json/mcp/mcp-adapter-default-server',
          auth: {
            method: 'oauth',
            client_id: 'x',
            access_token_ref: 'keychain://abilities-mcp/siteA/access',
            refresh_token_ref: 'keychain://abilities-mcp/siteA/refresh',
          },
          auth_status: 'active',
        },
      },
    });
    await assert.rejects(loadConfig({ config: file }), /not HTTPS/);
  });

  it('still accepts a legacy v1 App-Password site (no regression)', async () => {
    const file = writeTempConfig({
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          transport: 'http',
          http: {
            endpoint: 'https://example.com/wp-json/mcp/mcp-adapter-default-server',
            username: 'wp_user',
            password: 'pw',
          },
        },
      },
    });
    const cfg = await loadConfig({ config: file });
    assert.equal(cfg.sites.siteA.http.username, 'wp_user');
  });
});
