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
    prMetadata: { resource: `${siteUrl}/wp-json/mcp/abilities-mcp-adapter-default-server` },
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
          mcp_resource: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server',
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
    assert.equal(transport.endpoint, 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server');
  });

  it('routes App-Password sites to legacy HttpTransport unchanged (no regression)', async () => {
    // Post-migration v2 apppassword shape: legacy http.password* fields stripped,
    // secret in keychain via auth.password_ref. Pool resolves it via the injected
    // SecretStore.
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteB/apppassword', 'pw');

    const config = {
      defaultSite: 'siteB',
      sites: {
        siteB: {
          url: 'https://siteB.com',
          transport: 'http',
          http: {
            endpoint: 'https://siteB.com/wp-json/mcp/abilities-mcp-adapter-default-server',
            username: 'wp_user',
            password_ref: makeRef(SECRET_SERVICE, 'siteB/apppassword'),
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

    const pool = new ConnectionPool(config, () => {}, { secretStore: store });
    const transport = await pool._createTransport('siteB', null);
    assert.ok(transport instanceof HttpTransport,
      `expected HttpTransport, got ${transport && transport.constructor && transport.constructor.name}`);
    assert.ok(!(transport instanceof OAuthHttpTransport));
    assert.equal(transport.endpoint, 'https://siteB.com/wp-json/mcp/abilities-mcp-adapter-default-server');
    assert.equal(transport.username, 'wp_user');
    assert.equal(transport.password, 'pw');
  });

  it('routes legacy v1 HTTP sites (no auth block) to HttpTransport via sync resolver', async () => {
    // No SecretStore should be needed — falls through to resolvePassword(http).
    const config = {
      defaultSite: 'siteV1',
      sites: {
        siteV1: {
          url: 'https://v1.example.com',
          transport: 'http',
          http: {
            endpoint: 'https://v1.example.com/wp-json/mcp/abilities-mcp-adapter-default-server',
            username: 'v1_user',
            password: 'v1_pw',
          },
        },
      },
    };
    const pool = new ConnectionPool(config, () => {});
    const transport = await pool._createTransport('siteV1', null);
    assert.ok(transport instanceof HttpTransport);
    assert.equal(transport.username, 'v1_user');
    assert.equal(transport.password, 'v1_pw');
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
          mcp_resource: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server',
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
          mcp_resource: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server',
          auth: { method: 'oauth', client_id: 'x',
            access_token_ref: 'keychain://abilities-mcp/siteA/access',
            refresh_token_ref: 'keychain://abilities-mcp/siteA/refresh' },
          auth_status: 'active',
        },
      },
    };
    const pool = new ConnectionPool(config, () => {});
    pool.transports.set('siteA', { endpoint: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server' });
    const found = pool._findExistingHttpTransport('siteA');
    assert.ok(found, 'expected to find existing transport for OAuth site');
    assert.equal(found.key, 'siteA');
  });

  it('OAuth multisite subsite dedupes by subsite endpoint, NOT by network root (Issue #48)', async () => {
    // Pre-fix bug: targetEndpoint = siteConfig.mcp_resource always, so
    // wickedevolutions.community looking for an existing transport found
    // the cached `wickedevolutions` (network root) transport and reused it.
    // Outcome: every subsite call landed on blog 1.
    //
    // Post-fix: targetEndpoint = resolvedEndpoint || siteConfig.mcp_resource,
    // so subsite keys dedupe against subsite-host transports only.
    const config = {
      defaultSite: 'wicked',
      sites: {
        wicked: {
          url: 'https://wickedevolutions.com',
          mcp_resource: 'https://wickedevolutions.com/wp-json/mcp/abilities-mcp-adapter-default-server',
          auth: { method: 'oauth', client_id: 'x',
            access_token_ref: 'keychain://abilities-mcp/w/access',
            refresh_token_ref: 'keychain://abilities-mcp/w/refresh' },
          auth_status: 'active',
          multisite: {
            main: 'https://wickedevolutions.com',
            community: 'https://community.wickedevolutions.com',
          },
        },
      },
    };
    const pool = new ConnectionPool(config, () => {});
    // Seed cache with the network-root transport (parent / .main lookup path).
    const networkRootTransport = { endpoint: 'https://wickedevolutions.com/wp-json/mcp/abilities-mcp-adapter-default-server' };
    pool.transports.set('wicked', networkRootTransport);

    // Before #48: this returned the network-root transport. After #48: returns null,
    // so the pool builds a fresh subsite-host transport.
    const community = pool._findExistingHttpTransport('wicked.community');
    assert.equal(community, null,
      'subsite key MUST NOT reuse the network-root transport (that was the v1.5.4 routing bug)');

    // Same-host subsite (`.main`) still dedupes against the cached parent — the
    // dedupe logic should fold them onto the same transport since they post
    // to the same endpoint URL. Without this, the parent + .main get separate
    // transports competing for the same WP session.
    const main = pool._findExistingHttpTransport('wicked.main');
    assert.ok(main, 'same-host subsite should still dedupe against the parent transport');
    assert.equal(main.key, 'wicked');
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

/**
 * Issue #26 acceptance — post-migration multi-site v2 config routes every site to
 * the correct transport. Mirrors the operator-side Phase B reproduction: a v1
 * config with multiple http sites + an ssh site is migrated to v2 (legacy
 * http.password* fields stripped, secrets lifted to keychain), and the bridge
 * must boot and route each site without falling through to the legacy http
 * validator's "requires one of http.password..." check.
 */
describe('ConnectionPool — multi-site v2 acceptance (Issue #26)', () => {
  it('routes 1 oauth + 2 apppassword (http) + 1 ssh-carrier site to the correct transports', async () => {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'helena/access', 'AT');
    await store.set(SECRET_SERVICE, 'helena/refresh', 'RT');
    await store.set(SECRET_SERVICE, 'wicked/apppassword', 'wicked-pw');
    await store.set(SECRET_SERVICE, 'tnn/apppassword', 'tnn-pw');
    await store.set(SECRET_SERVICE, 'sshcarrier/apppassword', '');

    const tm = new TokenManager({ secretStore: store, allowInsecure: true });

    const config = {
      schema_version: 2,
      defaultSite: 'helena',
      sites: {
        helena: {
          url: 'https://helenawillow.com',
          mcp_resource: 'https://helenawillow.com/wp-json/mcp/abilities-mcp-adapter-default-server',
          auth: {
            method: 'oauth',
            client_id: 'client-h',
            access_token_ref: makeRef(SECRET_SERVICE, 'helena/access'),
            refresh_token_ref: makeRef(SECRET_SERVICE, 'helena/refresh'),
            access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          },
          auth_status: 'active',
        },
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
        tnn: {
          url: 'https://thinknicenow.com',
          transport: 'http',
          http: {
            endpoint: 'https://thinknicenow.com/wp-json/mcp/abilities-mcp-adapter-default-server',
            username: 'tnn_user',
            password_ref: makeRef(SECRET_SERVICE, 'tnn/apppassword'),
          },
          auth: {
            method: 'apppassword',
            username: 'tnn_user',
            password_ref: makeRef(SECRET_SERVICE, 'tnn/apppassword'),
          },
          auth_status: 'active',
        },
        sshcarrier: {
          url: 'ssh://shared.example',
          transport: 'ssh',
          ssh: { host: 'shared.example', path: '/var/www/wp', user: 'deploy' },
          auth: {
            method: 'apppassword',
            username: 'deploy',
            password_ref: makeRef(SECRET_SERVICE, 'sshcarrier/apppassword'),
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

    const helenaT = await pool._createTransport('helena', null);
    assert.ok(helenaT instanceof OAuthHttpTransport, 'helena should route to OAuthHttpTransport');
    assert.equal(helenaT.endpoint, 'https://helenawillow.com/wp-json/mcp/abilities-mcp-adapter-default-server');

    const wickedT = await pool._createTransport('wicked', null);
    assert.ok(wickedT instanceof HttpTransport, 'wicked should route to HttpTransport');
    assert.ok(!(wickedT instanceof OAuthHttpTransport));
    assert.equal(wickedT.username, 'wicked_user');
    assert.equal(wickedT.password, 'wicked-pw');

    const tnnT = await pool._createTransport('tnn', null);
    assert.ok(tnnT instanceof HttpTransport, 'tnn should route to HttpTransport');
    assert.equal(tnnT.username, 'tnn_user');
    assert.equal(tnnT.password, 'tnn-pw');

    const sshT = await pool._createTransport('sshcarrier', null);
    assert.ok(sshT instanceof SshTransport, 'sshcarrier should route to SshTransport');
  });

  it('rejects v2 apppassword http sites that lost auth.password_ref during a hand-edit', async () => {
    // Defensive — operator-edited configs should fail validation rather than
    // crash deeper in the resolver.
    const { loadConfig } = require('../lib/config');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const file = path.join(os.tmpdir(), `wp-sites.test.${process.pid}.${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({
      schema_version: 2,
      defaultSite: 'broken',
      sites: {
        broken: {
          url: 'https://broken.example',
          transport: 'http',
          http: {
            endpoint: 'https://broken.example/wp-json/mcp/abilities-mcp-adapter-default-server',
            username: 'u',
          },
          auth: { method: 'apppassword', username: 'u' },
          auth_status: 'active',
        },
      },
    }), { mode: 0o600 });
    try {
      await assert.rejects(loadConfig({ config: file }), /password_ref/);
    } finally {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  });
});

/**
 * OAuth subsite routing — Issue #48 acceptance.
 *
 * The OAuth branch of _createTransport must mirror the HTTP branch's use of
 * resolvedEndpoint when a multisite subsite key (`<site>.<subsite>`) is
 * dispatched, and must fall back to siteConfig.mcp_resource for single-site
 * keys. The bug was that OAuth ignored both resolved values and always
 * built the transport against the network root.
 *
 * Both directions are pinned so a future regression in either path fails
 * loudly.
 */
describe('ConnectionPool — OAuth subsite routing (Issue #48)', () => {
  function makeOAuthMultisitePool() {
    const store = new MemorySecretStore();
    return store.set(SECRET_SERVICE, 'wicked/access', 'AT')
      .then(() => store.set(SECRET_SERVICE, 'wicked/refresh', 'RT'))
      .then(() => {
        const tm = new TokenManager({ secretStore: store, allowInsecure: true });
        const config = {
          defaultSite: 'wickedevolutions',
          sites: {
            wickedevolutions: {
              url: 'https://wickedevolutions.com',
              mcp_resource: 'https://wickedevolutions.com/wp-json/mcp/abilities-mcp-adapter-default-server',
              auth: {
                method: 'oauth',
                client_id: 'client-x',
                access_token_ref: makeRef(SECRET_SERVICE, 'wicked/access'),
                refresh_token_ref: makeRef(SECRET_SERVICE, 'wicked/refresh'),
                access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
                refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
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
        const pool = new ConnectionPool(config, () => {}, {
          secretStore: store,
          tokenManager: tm,
          discover: fakeDiscover(),
          allowInsecure: true,
        });
        return pool;
      });
  }

  it('subsite key routes to subsite-host endpoint, not network root', async () => {
    const pool = await makeOAuthMultisitePool();
    const transport = await pool._createTransport('wickedevolutions.community', null);
    assert.ok(transport instanceof OAuthHttpTransport);
    assert.equal(
      transport.endpoint,
      'https://community.wickedevolutions.com/wp-json/mcp/abilities-mcp-adapter-default-server',
      'OAuth subsite must POST to the subsite host so multisite routes by URL — ' +
      'this was the GPT 5.5 review finding (all subsites returned 106 main-site posts)'
    );
    assert.equal(transport.subsiteUrl, 'https://community.wickedevolutions.com',
      'subsite URL should be forwarded to the transport for the X-Abilities-MCP-Subsite-URL header (Phase B)');
  });

  it('every subsite produces a distinct endpoint host', async () => {
    const pool = await makeOAuthMultisitePool();
    const subs = ['main', 'community', 'test1', 'knowledge'];
    const endpoints = [];
    for (const s of subs) {
      const t = await pool._createTransport(`wickedevolutions.${s}`, null);
      endpoints.push(t.endpoint);
    }
    const uniq = new Set(endpoints);
    assert.equal(uniq.size, subs.length,
      `expected 4 distinct subsite endpoints, got: ${[...uniq].join(' | ')}`);
  });

  it('single-site OAuth (no subsite suffix) still uses siteConfig.mcp_resource', async () => {
    // Pin the no-subsite direction so a future refactor of resolveSiteKey
    // doesn't accidentally null out the network-root fallback. This is the
    // helenawillow / wickedevolutions-no-suffix case.
    const pool = await makeOAuthMultisitePool();
    const transport = await pool._createTransport('wickedevolutions', null);
    assert.ok(transport instanceof OAuthHttpTransport);
    assert.equal(
      transport.endpoint,
      'https://wickedevolutions.com/wp-json/mcp/abilities-mcp-adapter-default-server',
      'no subsite suffix → siteConfig.mcp_resource (network root) is correct'
    );
    assert.equal(transport.subsiteUrl, null,
      'no subsite suffix → no subsite URL header forwarded');
  });
});

describe('ConnectionPool — connectDefault per-site auth-init isolation (#76)', () => {
  /**
   * Failure mode the gate forbids (verbatim from issue #76):
   *   "MCP server boots and responds with valid InitializeResult even when
   *    some/all configured sites have expired refresh tokens; degraded sites
   *    are reported via tools/list, per-call errors, or a dedicated tools/call
   *    shape — not via init failure."
   *
   * Pre-#76: `connectDefault()` connected one site (the configured default);
   * if that site's transport.connect() threw (RefreshError on expired refresh
   * token, per `lib/auth/token-manager.js:147-152`), the throw propagated to
   * the bootstrap catch in `abilities-mcp.js`, which `process.exit(1)`d the
   * bridge. The MCP client saw EOF and surfaced the malformed-InitializeResult
   * validator error.
   *
   * Post-#76: connectDefault tries the configured default first; on failure
   * it iterates other configured sites in order, returning the first transport
   * that successfully connects (and reassigning `config.defaultSite` in-memory).
   * Returns null only when ALL sites fail — boot does not exit.
   *
   * Drives `_createTransport` via a stub that succeeds/fails per site key.
   */
  function makeConfig(sites, defaultSite) {
    return { defaultSite, sites };
  }

  function fakeOAuthSite() {
    return {
      url: 'https://example.com',
      mcp_resource: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server',
      auth: {
        method: 'oauth',
        client_id: 'c',
        access_token_ref: 'ref:abilities-mcp:a',
        refresh_token_ref: 'ref:abilities-mcp:r',
      },
      auth_status: 'active',
    };
  }

  function makePoolWithStubs(config, perSiteOutcomes) {
    const pool = new ConnectionPool(config, () => {});
    pool._createTransport = async (key /* compositeKey */) => {
      const outcome = perSiteOutcomes[key];
      if (!outcome) throw new Error(`unconfigured outcome for ${key}`);
      if (outcome.throwAtCreate) throw outcome.throwAtCreate;
      const transport = {
        endpoint: `https://${key}.example.com/wp-json/mcp/abilities-mcp-adapter-default-server`,
        onMessage: null,
        connect: async () => {
          if (outcome.throwAtConnect) throw outcome.throwAtConnect;
        },
        send: () => {},
        shutdown: async () => {},
        isReady: () => true,
      };
      return transport;
    };
    return pool;
  }

  it('all sites healthy — no behavioral change for non-degraded operators (regression)', async () => {
    const config = makeConfig({
      siteA: fakeOAuthSite(),
      siteB: fakeOAuthSite(),
    }, 'siteA');
    const pool = makePoolWithStubs(config, {
      siteA: {},
      siteB: {},
    });
    const transport = await pool.connectDefault(() => {});
    assert.ok(transport, 'transport returned for healthy default site');
    assert.equal(config.defaultSite, 'siteA',
      'configured default unchanged when it connects successfully');
    assert.equal(config.sites.siteA.auth_status, 'active');
  });

  it('default site fails (RefreshError) → falls back to next configured site, marks default degraded', async () => {
    // The token-manager throws this exact error shape at lib/auth/token-manager.js:148.
    const refreshErr = new Error('Refresh token expired for site "siteA". Run: abilities-mcp reauth siteA');
    refreshErr.code = 'reauth_required';
    const config = makeConfig({
      siteA: fakeOAuthSite(),
      siteB: fakeOAuthSite(),
    }, 'siteA');
    const pool = makePoolWithStubs(config, {
      siteA: { throwAtConnect: refreshErr },
      siteB: {},
    });

    const transport = await pool.connectDefault(() => {});

    assert.ok(transport, 'fallback transport returned even when configured default fails');
    assert.equal(config.defaultSite, 'siteB',
      'in-memory defaultSite reassigned to fallback');
    assert.equal(config.sites.siteA.auth_status, 'expired',
      'configured default marked degraded so wp_bridge_health surfaces it');
    assert.match(config.sites.siteA._degraded_reason, /Refresh token expired/);
    assert.equal(config.sites.siteB.auth_status, 'active',
      'fallback site keeps its existing active status');
  });

  it('every site fails → returns null (bridge enters degraded mode in bootstrap)', async () => {
    const refreshErr = new Error('Refresh token expired');
    const config = makeConfig({
      siteA: fakeOAuthSite(),
      siteB: fakeOAuthSite(),
      siteC: fakeOAuthSite(),
    }, 'siteA');
    const pool = makePoolWithStubs(config, {
      siteA: { throwAtConnect: refreshErr },
      siteB: { throwAtConnect: refreshErr },
      siteC: { throwAtConnect: refreshErr },
    });

    const result = await pool.connectDefault(() => {});

    assert.equal(result, null,
      'all-sites-failed returns null so bootstrap enters degraded mode instead of exit(1)');
    assert.equal(config.sites.siteA.auth_status, 'expired');
    assert.equal(config.sites.siteB.auth_status, 'expired');
    assert.equal(config.sites.siteC.auth_status, 'expired');
  });

  it('first failure isolates — second site connects without re-attempting first', async () => {
    // Pin: the loop must not re-enter a failed site. Capture call order.
    const calls = [];
    const config = makeConfig({
      siteA: fakeOAuthSite(),
      siteB: fakeOAuthSite(),
    }, 'siteA');
    const pool = new ConnectionPool(config, () => {});
    pool._createTransport = async (key) => {
      calls.push(key);
      if (key === 'siteA') throw new Error('siteA failed');
      return {
        endpoint: 'https://b.example.com/x',
        onMessage: null,
        connect: async () => {},
        send: () => {},
        shutdown: async () => {},
        isReady: () => true,
      };
    };

    await pool.connectDefault(() => {});

    assert.deepEqual(calls, ['siteA', 'siteB'],
      'try order is configured-default-then-others; first failure does not retry');
  });

  it('error during _createTransport (not just connect) is also isolated', async () => {
    // The auth-init boundary covers BOTH _createTransport (discovery,
    // OAuth state setup) AND transport.connect() (token pre-fetch). Both
    // must isolate per-site.
    const config = makeConfig({
      siteA: fakeOAuthSite(),
      siteB: fakeOAuthSite(),
    }, 'siteA');
    const pool = makePoolWithStubs(config, {
      siteA: { throwAtCreate: new Error('discovery failed for siteA') },
      siteB: {},
    });

    const transport = await pool.connectDefault(() => {});

    assert.ok(transport, 'siteB transport returned despite siteA discovery failure');
    assert.equal(config.defaultSite, 'siteB');
    assert.equal(config.sites.siteA.auth_status, 'expired');
    assert.match(config.sites.siteA._degraded_reason, /discovery failed/);
  });
});

/**
 * Issue #103 (Component B) — prefer live-discovered protected-resource over
 * stale persisted mcp_resource.
 *
 * Uses the `discover` injection seam (this._discover) to stub discovery
 * with a controlled prMetadata.resource value, then asserts the created
 * OAuthHttpTransport gets the correct endpoint.
 */
describe('ConnectionPool — Issue #103 Component B: live-discovered resource preference', () => {
  function makeOAuthConfig(mcpResource) {
    return {
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          mcp_resource: mcpResource,
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
  }

  async function makePool(config, discoveredResource) {
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const tm = new TokenManager({ secretStore: store, allowInsecure: true });

    const discover = async (siteUrl) => ({
      asMetadata: {
        issuer: siteUrl,
        token_endpoint: `${siteUrl}/oauth/token`,
        authorization_endpoint: `${siteUrl}/oauth/authorize`,
      },
      asMetadataUrl: `${siteUrl}/.well-known/oauth-authorization-server`,
      prMetadata: discoveredResource ? { resource: discoveredResource } : null,
      prMetadataUrl: `${siteUrl}/.well-known/oauth-protected-resource`,
      probeResults: [],
    });

    const pool = new ConnectionPool(config, () => {}, {
      secretStore: store,
      tokenManager: tm,
      discover,
      allowInsecure: true,
    });
    return pool;
  }

  it('when live discovery resource differs from persisted mcp_resource, uses live resource', async () => {
    const persistedResource = 'https://example.com/wp-json/mcp/old-adapter-name';
    const liveResource = 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server';
    const config = makeOAuthConfig(persistedResource);

    const pool = await makePool(config, liveResource);
    const transport = await pool._createTransport('siteA', null);

    assert.ok(transport instanceof OAuthHttpTransport);
    assert.equal(transport.endpoint, liveResource,
      'live-discovered resource (RFC 9728 authoritative) should be used when persisted value is stale');
    assert.notEqual(transport.endpoint, persistedResource,
      'stale persisted mcp_resource must not be used when live discovery provides a different value');
  });

  it('when live discovery resource equals persisted mcp_resource, uses mcp_resource (no-op)', async () => {
    const resource = 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server';
    const config = makeOAuthConfig(resource);

    const pool = await makePool(config, resource);
    const transport = await pool._createTransport('siteA', null);

    assert.ok(transport instanceof OAuthHttpTransport);
    assert.equal(transport.endpoint, resource,
      'when persisted and live values match, endpoint is unchanged');
  });

  it('when resolvedEndpoint is set (multisite subsite), it wins over live discovery', async () => {
    // resolvedEndpoint is the operator-configured subsite endpoint and always
    // takes precedence — live discovery does not override it.
    const persistedResource = 'https://example.com/wp-json/mcp/old-adapter';
    const liveResource = 'https://example.com/wp-json/mcp/new-adapter';
    // resolveSiteKey (lib/config.js) builds a subsite endpoint as:
    //   subsite origin + the PARENT mcp_resource pathname.
    // It is intentionally derived from the persisted parent route, NOT from live
    // discovery — so the expected value carries the parent's `/old-adapter` path
    // on the subsite host. Component B must not override this operator-derived
    // endpoint.
    const subsiteEndpoint = 'https://community.example.com/wp-json/mcp/old-adapter';

    // Use a config with multisite so resolveSiteKey produces a resolvedEndpoint.
    const store = new MemorySecretStore();
    await store.set(SECRET_SERVICE, 'siteA/access', 'AT');
    await store.set(SECRET_SERVICE, 'siteA/refresh', 'RT');
    const tm = new TokenManager({ secretStore: store, allowInsecure: true });

    const config = {
      defaultSite: 'siteA',
      sites: {
        siteA: {
          url: 'https://example.com',
          mcp_resource: persistedResource,
          auth: {
            method: 'oauth',
            client_id: 'client-x',
            access_token_ref: makeRef(SECRET_SERVICE, 'siteA/access'),
            refresh_token_ref: makeRef(SECRET_SERVICE, 'siteA/refresh'),
            access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          },
          auth_status: 'active',
          multisite: {
            community: 'https://community.example.com',
          },
        },
      },
    };

    const discover = async (siteUrl) => ({
      asMetadata: {
        issuer: siteUrl,
        token_endpoint: `${siteUrl}/oauth/token`,
        authorization_endpoint: `${siteUrl}/oauth/authorize`,
      },
      asMetadataUrl: `${siteUrl}/.well-known/oauth-authorization-server`,
      prMetadata: { resource: liveResource },
      prMetadataUrl: `${siteUrl}/.well-known/oauth-protected-resource`,
      probeResults: [],
    });

    const pool = new ConnectionPool(config, () => {}, {
      secretStore: store, tokenManager: tm, discover, allowInsecure: true,
    });

    // siteA.community produces a resolvedEndpoint via resolveSiteKey.
    const transport = await pool._createTransport('siteA.community', null);
    assert.ok(transport instanceof OAuthHttpTransport);
    assert.equal(transport.endpoint, subsiteEndpoint,
      'resolvedEndpoint (multisite subsite) must win over live-discovered resource');
    assert.notEqual(transport.endpoint, liveResource,
      'live-discovered resource must NOT override an operator-derived subsite endpoint');
  });
});
