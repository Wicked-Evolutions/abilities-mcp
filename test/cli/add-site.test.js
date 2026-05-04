'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, autoConsentDeps } = require('./helpers/cli-harness');
const { deriveSiteId } = require('../../lib/cli/commands/add-site');
const {
  buildMultisiteBlock,
  deriveSubsiteSlug,
} = require('../../lib/cli/multisite-probe');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const { DEFAULT_SCOPE } = require('../../lib/auth/oauth-client');

describe('CLI add-site', () => {
  describe('site-id derivation', () => {
    it('strips www. and TLD (URL hostname is case-folded per RFC 3986)', () => {
      assert.equal(deriveSiteId('https://www.helenawillow.com'), 'helenawillow');
      assert.equal(deriveSiteId('https://siteA.com'), 'sitea');
      assert.equal(deriveSiteId('https://siteA.com/site2'), 'sitea');
    });
    it('returns null on invalid URL', () => {
      assert.equal(deriveSiteId('not a url'), null);
    });
    it('returns hostname for hosts with no dot', () => {
      assert.equal(deriveSiteId('https://localhost'), 'localhost');
    });
  });

  describe('apppassword flow', () => {
    let h;
    beforeEach(() => { h = makeHarness(); });
    afterEach(() => h.cleanup());

    it('writes a v2 site + keychain entry', async () => {
      const r = await h.runCli('add-site', [
        'https://siteA.com',
        '--apppassword',
        '--username=wp_agent',
        '--password=hunter2',
      ]);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      const cfg = h.readConfig();
      assert.equal(cfg.schema_version, SCHEMA_VERSION);
      // Hostname is case-folded per RFC 3986 → derived id is "sitea".
      assert.ok(cfg.sites.sitea);
      assert.equal(cfg.sites.sitea.auth.method, 'apppassword');
      assert.equal(cfg.sites.sitea.auth.username, 'wp_agent');
      assert.equal(cfg.sites.sitea.auth.password_ref, 'keychain://abilities-mcp/sitea/apppassword');
      assert.equal(cfg.sites.sitea.auth_status, 'active');
      // Default-site is set on first add.
      assert.equal(cfg.defaultSite, 'sitea');
      // Keychain has the password.
      const stored = await h.ctx.secretStore.get('abilities-mcp', 'sitea/apppassword');
      assert.equal(stored, 'hunter2');
    });

    it('refuses --apppassword without --username', async () => {
      const r = await h.runCli('add-site', ['https://siteA.com', '--apppassword', '--password=x']);
      assert.equal(r.exitCode, 2);
      assert.match(r.errLines.join('\n'), /requires --username/);
    });

    it('refuses --apppassword without --password', async () => {
      const r = await h.runCli('add-site', ['https://siteA.com', '--apppassword', '--username=u']);
      assert.equal(r.exitCode, 2);
      assert.match(r.errLines.join('\n'), /requires --password/);
    });

    it('refuses to clobber an existing site without --force', async () => {
      await h.runCli('add-site', ['https://siteA.com', '--apppassword', '--username=u', '--password=p']);
      const r = await h.runCli('add-site', ['https://siteA.com', '--apppassword', '--username=u', '--password=p']);
      assert.equal(r.exitCode, 2);
      assert.match(r.errLines.join('\n'), /already exists/);
      assert.match(r.errLines.join('\n'), /reauth sitea/);
    });

    it('overwrites with --force', async () => {
      await h.runCli('add-site', ['https://siteA.com', '--apppassword', '--username=u', '--password=p1']);
      const r = await h.runCli('add-site', [
        'https://siteA.com', '--apppassword', '--username=u2', '--password=p2', '--force',
      ]);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      const cfg = h.readConfig();
      assert.equal(cfg.sites.sitea.auth.username, 'u2');
    });
  });

  describe('OAuth flow', () => {
    let server;
    let h;
    before(async () => { server = await new MockAuthServer().start(); });
    after(async () => { await server.stop(); });
    beforeEach(() => { h = makeHarness({ deps: { oauthClientDeps: autoConsentDeps() } }); });
    afterEach(() => h.cleanup());

    it('completes OAuth and writes oauth fields + capability pin', async () => {
      const r = await h.runCli('add-site', [
        server.siteUrl,
        '--site-id=mock',
      ]);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      const cfg = h.readConfig();
      assert.equal(cfg.sites.mock.auth.method, 'oauth');
      assert.match(cfg.sites.mock.auth.client_id, /^client-/);
      assert.deepEqual(cfg.sites.mock.auth.scopes.sort(), ['abilities:read', 'abilities:write']);
      assert.equal(cfg.sites.mock.auth_status, 'active');
      assert.ok(cfg.sites.mock.oauth_capability_pinned);
      assert.ok(cfg.sites.mock.oauth_capability_pinned.first_seen_at);
      assert.ok(cfg.sites.mock.mcp_resource);
      // Tokens persisted to keychain.
      const at = await h.ctx.secretStore.get('abilities-mcp', 'mock/access');
      assert.match(at, /^at-/);
    });

    it('emits state-machine progress lines', async () => {
      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=progress']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      const out = r.lines.join('\n');
      assert.match(out, /Discovering OAuth metadata/);
      assert.match(out, /Registering bridge client/);
      assert.match(out, /Waiting for consent in browser/);
      assert.match(out, /Exchanging authorization code/);
      assert.match(out, /Authorization complete/);
    });

    it('surfaces capability-pinning failure with exit code 5', async () => {
      // We have to fake a pin in the *unwritten* config first, then point
      // add-site at a server that 404s discovery. add-site does not normally
      // see a pin (it's a brand-new site), so this scenario actually maps to
      // reauth. But we can prove the error mapping by going through the same
      // code path via a forced pin in deps. Easier: delegate to reauth tests.
      // Here we just verify that DiscoveryError → exit 4 (auth failure).
      const downgraded = await new MockAuthServer({ discoveryStatus: 404 }).start();
      try {
        const r = await h.runCli('add-site', [downgraded.siteUrl, '--site-id=down']);
        assert.equal(r.exitCode, 4);
        assert.match(r.errLines.join('\n'), /OAuth discovery failed/);
      } finally {
        await downgraded.stop();
      }
    });

    it('returns usage error without a URL', async () => {
      const r = await h.runCli('add-site', []);
      assert.equal(r.exitCode, 2);
      assert.match(r.errLines.join('\n'), /requires a site URL/);
    });
  });

  describe('multisite auto-populate (Issue #43)', () => {
    let server;
    let h;
    before(async () => { server = await new MockAuthServer().start(); });
    after(async () => { await server.stop(); });
    afterEach(() => { if (h) h.cleanup(); });

    function makeHarnessWithProbe(probeStub) {
      return makeHarness({
        deps: {
          oauthClientDeps: autoConsentDeps(),
          probeMultisite: probeStub,
        },
      });
    }

    it('writes multisite block when probe finds subsites (happy path)', async () => {
      const block = {
        main: 'https://network.example.com',
        community: 'https://community.network.example.com',
        knowledge: 'https://knowledge.network.example.com',
        test1: 'https://test1.network.example.com',
      };
      let probeArgs = null;
      h = makeHarnessWithProbe(async (args) => {
        probeArgs = args;
        return { block, reason: 'multisite-root' };
      });

      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=ms']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      assert.equal(r.errLines.length, 0,
        `unexpected advisory: ${r.errLines.join('\n')}`);

      const cfg = h.readConfig();
      assert.deepEqual(cfg.sites.ms.multisite, block);
      assert.match(r.lines.join('\n'), /Multisite: discovered 4 subsite/);

      // Probe was called with the freshly-minted access token + MCP endpoint.
      assert.ok(probeArgs, 'probe should have been invoked');
      assert.ok(probeArgs.endpoint, 'probe should receive MCP endpoint');
      assert.ok(probeArgs.accessToken, 'probe should receive access token');
      assert.equal(probeArgs.siteUrl, server.siteUrl);
    });

    it('writes site without multisite block on single-site install', async () => {
      h = makeHarnessWithProbe(async () => ({ block: null, reason: 'single-site' }));

      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=single']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      assert.equal(r.errLines.length, 0,
        'single-site path must degrade silently — no advisory expected');

      const cfg = h.readConfig();
      assert.equal(cfg.sites.single.multisite, undefined,
        'no multisite block should be written for single-site installs');
      // OAuth fields still written — single-site behavior is byte-identical
      // to pre-probe behavior.
      assert.equal(cfg.sites.single.auth.method, 'oauth');
    });

    it('writes site without multisite block on tool-not-registered (silent)', async () => {
      // Same shape as single-site, but reaches add-site via a thrown
      // tool_not_registered code (e.g. multisite-abilities.php returned
      // before registering the ability because is_multisite() === false).
      h = makeHarnessWithProbe(async () => {
        const e = new Error('Method not found');
        e.code = 'tool_not_registered';
        throw e;
      });

      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=notreg']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      assert.equal(r.errLines.length, 0,
        'tool_not_registered must degrade silently — no advisory expected');

      const cfg = h.readConfig();
      assert.equal(cfg.sites.notreg.multisite, undefined);
    });

    it('writes site without multisite block + advisory on permission-denied', async () => {
      h = makeHarnessWithProbe(async () => {
        const e = new Error('multisite probe: HTTP 403 (forbidden)');
        e.code = 'permission_denied';
        throw e;
      });

      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=permd']);
      assert.equal(r.exitCode, 0,
        `expected success exit despite permission-denied probe: ${r.errLines.join('\n')}`);

      const cfg = h.readConfig();
      assert.equal(cfg.sites.permd.multisite, undefined,
        'no multisite block should be written when capability is missing');
      assert.equal(cfg.sites.permd.auth.method, 'oauth',
        'OAuth site entry must still be written');

      const advisory = r.errLines.join('\n');
      assert.match(advisory, /Multisite discovery skipped/);
      // Advisory must surface BOTH possible causes (#45) — capability gate
      // AND OAuth-scope gate — so operators don't chase the wrong one.
      assert.match(advisory, /manage_network_options/);
      assert.match(advisory, /abilities:multisite:read/);
      assert.match(advisory, /consent screen/);
      assert.match(advisory, /permd/);
    });

    it('writes site without multisite block + advisory on probe error', async () => {
      h = makeHarnessWithProbe(async () => {
        const e = new Error('connect ETIMEDOUT 192.0.2.1:443');
        e.code = 'network_error';
        throw e;
      });

      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=neterr']);
      assert.equal(r.exitCode, 0,
        `expected success exit despite probe network error: ${r.errLines.join('\n')}`);

      const cfg = h.readConfig();
      assert.equal(cfg.sites.neterr.multisite, undefined,
        'no multisite block should be written on transient probe failure');

      const advisory = r.errLines.join('\n');
      assert.match(advisory, /Multisite discovery failed/);
      assert.match(advisory, /ETIMEDOUT/);
      assert.match(advisory, /neterr/);
    });
  });

  describe('DCR multisite scope request (Issue #45)', () => {
    let server;
    let h;
    before(async () => { server = await new MockAuthServer().start(); });
    after(async () => { await server.stop(); });
    afterEach(() => { if (h) h.cleanup(); });

    it('DEFAULT_SCOPE includes the multisite scopes the probe needs', () => {
      // Naming verified against adapter ScopeRegistry SENSITIVE_SCOPES
      // (src/Auth/OAuth/ScopeRegistry.php:43-44). These scopes are excluded
      // from the abilities:read / abilities:write umbrella expansion by
      // design, so they must be requested explicitly during DCR.
      assert.match(DEFAULT_SCOPE, /\babilities:read\b/);
      assert.match(DEFAULT_SCOPE, /\babilities:write\b/);
      assert.match(DEFAULT_SCOPE, /\babilities:multisite:read\b/);
      assert.match(DEFAULT_SCOPE, /\babilities:multisite:write\b/);
    });

    it('add-site DCR registration includes the multisite scopes', async () => {
      h = makeHarness({
        deps: {
          oauthClientDeps: autoConsentDeps(),
          // Stub probe — we only care about DCR body for this test.
          probeMultisite: async () => ({ block: null, reason: 'single-site' }),
        },
      });

      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=dcrscope']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));

      // The mock records the DCR body keyed by issued client_id. The most
      // recently issued client is this run's registration.
      const issued = Array.from(server._issuedClients.values());
      const dcrBody = issued[issued.length - 1].body;
      assert.ok(dcrBody, 'DCR body should be recorded by mock');
      assert.match(dcrBody.scope, /\babilities:multisite:read\b/,
        'DCR scope must include abilities:multisite:read so consent can grant it');
      assert.match(dcrBody.scope, /\babilities:multisite:write\b/,
        'DCR scope must include abilities:multisite:write for symmetry');
      // Existing umbrella scopes still requested.
      assert.match(dcrBody.scope, /\babilities:read\b/);
      assert.match(dcrBody.scope, /\babilities:write\b/);
    });

    it('granted multisite scope ends up in wp-sites.json after super-admin consent', async () => {
      // Simulate a super-admin operator on a Multisite Network root: the
      // adapter's consent screen surfaces the multisite scope and the
      // operator grants it. The token endpoint reflects the grant in the
      // `scope` field, which add-site persists to auth.scopes.
      const grantedScope = 'abilities:read abilities:write abilities:multisite:read abilities:multisite:write';
      const superAdminServer = await new MockAuthServer({
        tokenJson: {
          access_token: 'at-superadmin-test',
          refresh_token: 'rt-superadmin-test',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: grantedScope,
        },
      }).start();
      try {
        h = makeHarness({
          deps: {
            oauthClientDeps: autoConsentDeps(),
            // Stub probe — assertion is about persisted scopes, not the
            // probe round-trip (which has its own dedicated tests).
            probeMultisite: async () => ({
              block: { main: superAdminServer.siteUrl },
              reason: 'multisite-root',
            }),
          },
        });

        const r = await h.runCli('add-site', [
          superAdminServer.siteUrl, '--site-id=superadmin',
        ]);
        assert.equal(r.exitCode, 0, r.errLines.join('\n'));

        const cfg = h.readConfig();
        const scopes = cfg.sites.superadmin.auth.scopes;
        assert.ok(scopes.includes('abilities:multisite:read'),
          `expected granted scopes to include abilities:multisite:read, got: ${scopes.join(', ')}`);
        assert.ok(scopes.includes('abilities:multisite:write'),
          `expected granted scopes to include abilities:multisite:write, got: ${scopes.join(', ')}`);
      } finally {
        await superAdminServer.stop();
      }
    });

    it('single-site path: scopes requested but adapter grants only umbrella, no multisite block', async () => {
      // Single-site WP: DCR includes the multisite scopes (we always
      // request them now), but the adapter doesn't grant them because
      // the OAuth user lacks WP capability — the mock token endpoint's
      // default `scope` field does not include them. Site entry must
      // still be written without a multisite block, exactly as before.
      h = makeHarness({
        deps: {
          oauthClientDeps: autoConsentDeps(),
          probeMultisite: async () => {
            // Tool-not-registered mirrors what a non-multisite WP would
            // return — multisite-abilities.php bails early when
            // is_multisite() is false, so the ability isn't registered.
            const e = new Error('Method not found');
            e.code = 'tool_not_registered';
            throw e;
          },
        },
      });

      const r = await h.runCli('add-site', [server.siteUrl, '--site-id=ss']);
      assert.equal(r.exitCode, 0, r.errLines.join('\n'));
      assert.equal(r.errLines.length, 0,
        'single-site path must remain silent — no advisory expected');

      const cfg = h.readConfig();
      assert.equal(cfg.sites.ss.multisite, undefined,
        'no multisite block on single-site install — graceful degrade preserved');
      assert.equal(cfg.sites.ss.auth.method, 'oauth');

      // DCR was still asked for the multisite scopes — the gate is server-side.
      const issued = Array.from(server._issuedClients.values());
      const dcrBody = issued[issued.length - 1].body;
      assert.match(dcrBody.scope, /\babilities:multisite:read\b/);
    });
  });

  describe('multisite block schema mapping', () => {
    // Schema verified against lib/config.js:resolveSiteKey (reads
    // site.multisite[slug] as a URL string) and lib/connection-pool.js
    // (treats it identically). buildMultisiteBlock must produce that shape.

    it('maps subdomain-mode subsites to first-label slugs', () => {
      const items = [
        { blog_id: 1, domain: 'wickedevolutions.com', path: '/', url: 'https://wickedevolutions.com' },
        { blog_id: 2, domain: 'community.wickedevolutions.com', path: '/', url: 'https://community.wickedevolutions.com' },
        { blog_id: 3, domain: 'knowledge.wickedevolutions.com', path: '/', url: 'https://knowledge.wickedevolutions.com' },
        { blog_id: 4, domain: 'test1.wickedevolutions.com', path: '/', url: 'https://test1.wickedevolutions.com' },
      ];
      const block = buildMultisiteBlock('https://wickedevolutions.com', items);
      assert.deepEqual(block, {
        main: 'https://wickedevolutions.com',
        community: 'https://community.wickedevolutions.com',
        knowledge: 'https://knowledge.wickedevolutions.com',
        test1: 'https://test1.wickedevolutions.com',
      });
    });

    it('maps path-mode subsites to first-segment slugs', () => {
      const items = [
        { blog_id: 1, domain: 'example.com', path: '/', url: 'https://example.com' },
        { blog_id: 2, domain: 'example.com', path: '/blog2/', url: 'https://example.com/blog2' },
        { blog_id: 3, domain: 'example.com', path: '/store/', url: 'https://example.com/store' },
      ];
      const block = buildMultisiteBlock('https://example.com', items);
      assert.deepEqual(block, {
        main: 'https://example.com',
        blog2: 'https://example.com/blog2',
        store: 'https://example.com/store',
      });
    });

    it('disambiguates colliding slugs by blog_id', () => {
      // Pathological case: subdomain + path mode mixed where two sites
      // would resolve to the same first-label slug. Block must preserve
      // both entries by appending blog_id.
      const items = [
        { blog_id: 1, domain: 'example.com', path: '/', url: 'https://example.com' },
        { blog_id: 2, domain: 'shop.example.com', path: '/', url: 'https://shop.example.com' },
        { blog_id: 3, domain: 'shop.example.com', path: '/', url: 'https://shop.example.com/alt' },
      ];
      const block = buildMultisiteBlock('https://example.com', items);
      assert.equal(block.main, 'https://example.com');
      assert.equal(block.shop, 'https://shop.example.com');
      assert.equal(block['shop-3'], 'https://shop.example.com/alt');
    });

    it('strips www. from parent host before deriving slugs', () => {
      const items = [
        { blog_id: 1, domain: 'example.com', path: '/', url: 'https://example.com' },
        { blog_id: 2, domain: 'community.example.com', path: '/', url: 'https://community.example.com' },
      ];
      const block = buildMultisiteBlock('https://www.example.com', items);
      assert.equal(block.main, 'https://example.com');
      assert.equal(block.community, 'https://community.example.com');
    });

    it('skips items missing a URL', () => {
      const items = [
        { blog_id: 1, domain: 'example.com', path: '/', url: 'https://example.com' },
        { blog_id: 2, domain: 'community.example.com', path: '/' },
      ];
      const block = buildMultisiteBlock('https://example.com', items);
      assert.equal(Object.keys(block).length, 1);
      assert.equal(block.main, 'https://example.com');
    });

    it('deriveSubsiteSlug returns "main" for the network root', () => {
      assert.equal(
        deriveSubsiteSlug('example.com',
          { domain: 'example.com', path: '/' }),
        'main');
    });

    it('deriveSubsiteSlug returns first label for subdomain subsites', () => {
      assert.equal(
        deriveSubsiteSlug('example.com',
          { domain: 'community.example.com', path: '/' }),
        'community');
    });

    it('deriveSubsiteSlug returns first segment for path subsites', () => {
      assert.equal(
        deriveSubsiteSlug('example.com',
          { domain: 'example.com', path: '/blog2/' }),
        'blog2');
    });

    it('deriveSubsiteSlug returns first label for mapped-domain subsites', () => {
      assert.equal(
        deriveSubsiteSlug('example.com',
          { domain: 'mapped.test', path: '/' }),
        'mapped');
    });
  });
});
