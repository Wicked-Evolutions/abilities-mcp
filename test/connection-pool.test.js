'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ConnectionPool } = require('../lib/connection-pool');
const { OAuthHttpTransport } = require('../lib/transports/oauth-http-transport');
const { HttpTransport } = require('../lib/transports/http-transport');
const { SshTransport } = require('../lib/transports/ssh-transport');
const { TokenManager, SECRET_SERVICE } = require('../lib/auth/token-manager');
const { MemorySecretStore } = require('../lib/auth/memory-secret-store');
const { makeRef } = require('../lib/auth/secret-store');

/**
 * ConnectionPool dispatch — Issue #17 acceptance criteria.
 *
 * The pool must select OAuthHttpTransport for v2 OAuth sites and leave
 * App-Password / SSH sites on their existing legacy transports unchanged.
 */

function fakeDiscover() {
  return async (siteUrl) => ({
    asMetadata: {
      issuer: siteUrl,
      token_endpoint: `${siteUrl}/oauth/token`,
      authorization_endpoint: `${siteUrl}/oauth/authorize`,
    },
    asMetadataUrl: `${siteUrl}/.well-known/oauth-authorization-server`,
    prMetadata: { resource: `${siteUrl}/wp-json/mcp/mcp-adapter-default-server` },
    prMetadataUrl: `${siteUrl}/.well-known/oauth-protected-resource`,
    probeResults: [],
  });
}

describe('ConnectionPool dispatch — auth.method === "oauth"', () => {
  it('builds an OAuthHttpTransport for OAuth sites', async () => {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const tm = new TokenManager({ secretStore: store, allowInsecure: true });

    const config = {
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          mcp_resource: 'https://example.com/wp-json/mcp/mcp-adapter-default-server',
          auth: {
            method: 'oauth',
            client_id: 'client-x',
            access_token_ref: makeRef(SECRET_SERVICE, 'siteA/access'),
            refresh_token_ref: makeRef(SECRET_SERVICE, 'siteA/refresh'),
            access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          },
          auth_status: 'active',
        },
      },
    };

    const pool = new ConnectionPool(config, () => {}, {
      secretStore: store,
      tokenManager: tm,
      discover: fakeDiscover(),
      allowInsecure: true,
    });

    const transport = await pool._createTransport('siteA', null);
    assert.ok(transport instanceof OAuthHttpTransport,
      `expected OAuthHttpTransport, got ${transport && transport.constructor && transport.constructor.name}`);
    assert.equal(transport.endpoint, 'https://example.com/wp-json/mcp/mcp-adapter-default-server');
  });

  it('routes App-Password sites to legacy HttpTransport unchanged (no regression)', async () => {
    const config = {
      defaultSite: 'siteB',
      sites: {
        siteB: {
          url: 'https://siteB.com',
          transport: 'http',
          http: {
            endpoint: 'https://siteB.com/wp-json/mcp/mcp-adapter-default-server',
            username: 'wp_user',
            password: 'pw',
          },
          auth: {
            method: 'apppassword',
            username: 'wp_user',
            password_ref: makeRef(SECRET_SERVICE, 'siteB/apppassword'),
          },
          auth_status: 'active',
        },
      },
    };

    const pool = new ConnectionPool(config, () => {});
    const transport = await pool._createTransport('siteB', null);
    assert.ok(transport instanceof HttpTransport,
      `expected HttpTransport, got ${transport && transport.constructor && transport.constructor.name}`);
    assert.ok(!(transport instanceof OAuthHttpTransport));
    assert.equal(transport.endpoint, 'https://siteB.com/wp-json/mcp/mcp-adapter-default-server');
  });

  it('routes SSH carrier-only sites to SshTransport unchanged', async () => {
    const config = {
      defaultSite: 'siteC',
      sites: {
        siteC: {
          url: 'ssh://siteC.example',
          transport: 'ssh',
          ssh: { host: 'siteC.example', path: '/var/www/wp', user: 'ssh' },
          auth: {
            method: 'apppassword',
            username: 'ssh',
            password_ref: makeRef(SECRET_SERVICE, 'siteC/apppassword'),
          },
          auth_status: 'active',
        },
      },
    };
    const pool = new ConnectionPool(config, () => {});
    const transport = await pool._createTransport('siteC', null);
    assert.ok(transport instanceof SshTransport);
  });

  it('throws a clear error when an OAuth site is missing mcp_resource', async () => {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const config = {
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          // mcp_resource intentionally missing
          auth: {
            method: 'oauth',
            client_id: 'x',
            access_token_ref: makeRef(SECRET_SERVICE, 'siteA/access'),
            refresh_token_ref: makeRef(SECRET_SERVICE, 'siteA/refresh'),
          },
          auth_status: 'active',
        },
      },
    };
    const pool = new ConnectionPool(config, () => {}, {
      secretStore: store, discover: fakeDiscover(), allowInsecure: true,
    });
    await assert.rejects(
      pool._createTransport('siteA', null),
      /no mcp_resource configured|reauth siteA/,
    );
  });

  it('propagates CapabilityPinningError from discovery (H.2.3 fail-loud)', async () => {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const { CapabilityPinningError } = require('../lib/auth/errors');

    const failingDiscover = async () => {
      throw new CapabilityPinningError(
        'Site previously supported OAuth but now reports no OAuth.',
        { state: 'discovering' }
      );
    };

    const config = {
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          mcp_resource: 'https://example.com/wp-json/mcp/mcp-adapter-default-server',
          auth: {
            method: 'oauth',
            client_id: 'x',
            access_token_ref: makeRef(SECRET_SERVICE, 'siteA/access'),
            refresh_token_ref: makeRef(SECRET_SERVICE, 'siteA/refresh'),
          },
          auth_status: 'active',
          oauth_capability_pinned: {
            first_seen_at: '2026-01-15T10:00:00Z',
            last_confirmed_at: '2026-04-01T10:00:00Z',
          },
        },
      },
    };
    const pool = new ConnectionPool(config, () => {}, {
      secretStore: store, discover: failingDiscover, allowInsecure: true,
    });
    await assert.rejects(
      pool._createTransport('siteA', null),
      (err) => err instanceof CapabilityPinningError,
    );
  });
});

describe('ConnectionPool — _findExistingHttpTransport handles both transport variants', () => {
  it('dedupes OAuth sites by mcp_resource', async () => {
    const config = {
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          mcp_resource: 'https://example.com/wp-json/mcp/mcp-adapter-default-server',
          auth: { method: 'oauth', client_id: 'x',
            access_token_ref: 'keychain://abilities-mcp/siteA/access',
            refresh_token_ref: 'keychain://abilities-mcp/siteA/refresh' },
          auth_status: 'active',
        },
      },
    };
    const pool = new ConnectionPool(config, () => {});
    pool.transports.set('siteA', { endpoint: 'https://example.com/wp-json/mcp/mcp-adapter-default-server' });
    const found = pool._findExistingHttpTransport('siteA');
    assert.ok(found, 'expected to find existing transport for OAuth site');
    assert.equal(found.key, 'siteA');
  });

  it('returns null for non-HTTP / non-OAuth sites with no endpoint', async () => {
    const config = {
      defaultSite: 'ssh1',
      sites: {
        ssh1: {
          url: 'ssh://x', transport: 'ssh', ssh: { host: 'x', path: '/' },
          auth: { method: 'apppassword', username: 'u', password_ref: 'keychain://abilities-mcp/ssh1/apppassword' },
          auth_status: 'active',
        },
      },
    };
    const pool = new ConnectionPool(config, () => {});
    const found = pool._findExistingHttpTransport('ssh1');
    assert.equal(found, null);
  });
});
