'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, resolveSiteKey } = require('../lib/config');

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

/**
 * resolveSiteKey — multisite endpoint derivation (Issue #48).
 *
 * Subdomain-style multisite routes by URL host. The pool relies on
 * resolveSiteKey to substitute the subsite's origin into the parent
 * endpoint path so the OAuth and HTTP branches can post to the correct
 * blog. Before the fix, OAuth subsite keys returned resolvedEndpoint=null
 * because the substitution branch only fired for site.transport === 'http'
 * — and OAuth sites carry no `transport` block.
 */
describe('resolveSiteKey — multisite endpoint derivation (Issue #48)', () => {
  function makeOAuthMultisiteConfig() {
    return {
      sites: {
        wickedevolutions: {
          url: 'https://wickedevolutions.com',
          mcp_resource: 'https://wickedevolutions.com/wp-json/mcp/mcp-adapter-default-server',
          auth: {
            method: 'oauth',
            client_id: 'client-x',
            access_token_ref: 'keychain://abilities-mcp/we/access',
            refresh_token_ref: 'keychain://abilities-mcp/we/refresh',
          },
          auth_status: 'active',
          multisite: {
            main: 'https://wickedevolutions.com',
            community: 'https://community.wickedevolutions.com',
            test1: 'https://test1.wickedevolutions.com',
            knowledge: 'https://knowledge.wickedevolutions.com',
          },
        },
      },
    };
  }

  it('OAuth subsite resolves to subsite-host endpoint (was null before #48)', () => {
    const config = makeOAuthMultisiteConfig();
    const r = resolveSiteKey(config, 'wickedevolutions.community');
    assert.equal(r.subsiteUrl, 'https://community.wickedevolutions.com');
    assert.equal(
      r.resolvedEndpoint,
      'https://community.wickedevolutions.com/wp-json/mcp/mcp-adapter-default-server',
      'subsite endpoint must use the subsite host so multisite routes by URL'
    );
  });

  it('every OAuth subsite resolves to its own host (no shared-network-root regression)', () => {
    const config = makeOAuthMultisiteConfig();
    const subsites = ['main', 'community', 'test1', 'knowledge'];
    const endpoints = subsites.map((s) => resolveSiteKey(config, `wickedevolutions.${s}`).resolvedEndpoint);
    // Every endpoint distinct (sanity — bug had them all equal to the network root).
    const uniq = new Set(endpoints);
    assert.equal(uniq.size, subsites.length, `expected 4 distinct subsite endpoints, got ${[...uniq].join(' | ')}`);
    // Each endpoint's host matches its subsite's host.
    for (let i = 0; i < subsites.length; i++) {
      const expectedHost = new URL(config.sites.wickedevolutions.multisite[subsites[i]]).hostname;
      const actualHost = new URL(endpoints[i]).hostname;
      assert.equal(actualHost, expectedHost, `subsite "${subsites[i]}" endpoint host mismatch`);
    }
  });

  it('OAuth single-site (no dot suffix) returns null resolvedEndpoint', () => {
    // Single-site keys return the raw siteConfig with no subsite resolution;
    // the pool then falls back to siteConfig.mcp_resource as the endpoint.
    const config = makeOAuthMultisiteConfig();
    const r = resolveSiteKey(config, 'wickedevolutions');
    assert.equal(r.subsiteUrl, null);
    assert.equal(r.resolvedEndpoint, null);
  });

  it('HTTP App-Password subsite resolution still works (no regression)', () => {
    const config = {
      sites: {
        wp: {
          url: 'https://example.com',
          transport: 'http',
          http: { endpoint: 'https://example.com/wp-json/mcp/mcp-adapter-default-server' },
          multisite: { sub: 'https://sub.example.com' },
        },
      },
    };
    const r = resolveSiteKey(config, 'wp.sub');
    assert.equal(
      r.resolvedEndpoint,
      'https://sub.example.com/wp-json/mcp/mcp-adapter-default-server'
    );
  });
});
