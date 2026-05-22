'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MockAuthServer } = require('../auth/helpers/mock-auth-server');
const { makeHarness, autoConsentDeps, v2SiteOAuth, v2SiteAppPassword } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');

describe('CLI reauth', () => {
  let server;
  let h;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });
  beforeEach(() => { h = makeHarness({ deps: { oauthClientDeps: autoConsentDeps() } }); });
  afterEach(() => h.cleanup());

  it('replaces tokens and preserves capabilityPin.first_seen_at', async () => {
    const firstSeen = new Date('2026-01-15T00:00:00.000Z').toISOString();
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        mock: Object.assign(v2SiteOAuth(server.siteUrl), {
          oauth_capability_pinned: { first_seen_at: firstSeen, last_confirmed_at: firstSeen },
        }),
      },
    });
    const r = await h.runCli('reauth', ['mock']);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    const cfg = h.readConfig();
    assert.equal(cfg.sites.mock.auth.method, 'oauth');
    assert.equal(cfg.sites.mock.oauth_capability_pinned.first_seen_at, firstSeen,
      'first_seen_at must survive reauth (H.2.3)');
    assert.notEqual(cfg.sites.mock.oauth_capability_pinned.last_confirmed_at, firstSeen);
    assert.equal(cfg.sites.mock.auth_status, 'active');
  });

  it('preserves apppassword_fallback so an in-progress upgrade-auth survives reauth', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        mock: Object.assign(v2SiteOAuth(server.siteUrl), {
          auth: Object.assign({}, v2SiteOAuth(server.siteUrl).auth, {
            apppassword_fallback: {
              username: 'wp_admin',
              password_ref: 'keychain://abilities-mcp/mock/apppassword-legacy',
            },
          }),
        }),
      },
    });
    const r = await h.runCli('reauth', ['mock']);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    const cfg = h.readConfig();
    assert.ok(cfg.sites.mock.auth.apppassword_fallback);
    assert.equal(cfg.sites.mock.auth.apppassword_fallback.username, 'wp_admin');
  });

  it('errors on unknown site_id', async () => {
    h.writeConfig({ schema_version: SCHEMA_VERSION, sites: {} });
    const r = await h.runCli('reauth', ['ghost']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /unknown site_id "ghost"/);
  });

  it('errors when site uses apppassword (suggests upgrade-auth)', async () => {
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: { siteB: v2SiteAppPassword('https://siteB.com') },
    });
    const r = await h.runCli('reauth', ['siteB']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /upgrade-auth siteB/);
  });

  it('requires a site_id argument', async () => {
    h.writeConfig({ schema_version: SCHEMA_VERSION, sites: {} });
    const r = await h.runCli('reauth', []);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /requires a site_id/);
  });
});

/**
 * Issue #50 — --add-scope / --remove-scope / --scope flag triad.
 *
 * Pure scope-mutation logic is exhaustively covered in
 * test/cli/scope-mutation.test.js. These tests pin the CLI wiring:
 *   - the right flag arrives as the right field on `args`
 *   - the resolved scope set is what gets passed into OAuthClient
 *   - warnings surface on stderr (errLines), not stdout (lines)
 *   - mutual-exclusion failures exit with EXIT_USAGE before reaching the
 *     OAuth flow at all
 *
 * Drives reauth via a stub OAuthClient (deps.OAuthClient = StubOAuthClient)
 * so the test captures the constructor's `scope` argument directly. The
 * MockAuthServer hardcodes the granted scope on token responses, so going
 * through the real OAuth flow can't pin "the bridge sent X."
 */
describe('CLI reauth — scope mutation flags (Issue #50)', () => {
  let h;
  let captured;
  let StubOAuthClient;
  before(() => {
    StubOAuthClient = class {
      constructor(opts) {
        captured = opts;
        this.opts = opts;
        this._listeners = new Map();
      }
      on() { return this; }
      emit() { return this; }
      async run() {
        return {
          tokens: {
            access_token: 'AT-stub', refresh_token: 'RT-stub',
            token_type: 'Bearer', expires_in: 3600,
          },
          scopes: Array.isArray(this.opts.scope)
            ? this.opts.scope.slice()
            : String(this.opts.scope || '').split(/[,\s]+/).filter(Boolean),
          clientId: 'client-stub',
          asMetadata: { issuer: this.opts.siteUrl },
          prMetadata: { resource: `${this.opts.siteUrl}/wp-json/mcp/abilities-mcp-adapter-default-server` },
          capabilityPin: {
            firstSeenAt: new Date('2026-01-01T00:00:00Z').toISOString(),
            lastConfirmedAt: new Date().toISOString(),
          },
        };
      }
    };
  });
  beforeEach(() => {
    captured = null;
    h = makeHarness({ deps: { OAuthClient: StubOAuthClient } });
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: {
        helena: {
          url: 'https://helenawillow.com',
          mcp_resource: 'https://helenawillow.com/wp-json/mcp/abilities-mcp-adapter-default-server',
          auth: {
            method: 'oauth',
            client_id: 'client-test',
            user_login: 'wp_agent',
            scopes: [
              'abilities:read',
              'abilities:write',
              'abilities:multisite:read',
              'abilities:multisite:write',
            ],
            access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
            access_token_ref: 'keychain://abilities-mcp/helena/access',
            refresh_token_ref: 'keychain://abilities-mcp/helena/refresh',
          },
          auth_status: 'active',
        },
      },
    });
  });
  afterEach(() => h.cleanup());

  it('bare reauth uses the persisted scope set (regression — Issue #50 must not change existing behavior)', async () => {
    const r = await h.runCli('reauth', ['helena']);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.deepEqual(captured.scope, [
      'abilities:read', 'abilities:write',
      'abilities:multisite:read', 'abilities:multisite:write',
    ]);
    assert.deepEqual(r.errLines, [], 'bare reauth must produce no stderr advisories');
  });

  it('--add-scope merges new scopes into the existing set and dedupes', async () => {
    const r = await h.runCli('reauth', [
      'helena',
      '--add-scope=abilities:settings:read,abilities:fluent-cart:read,abilities:read',
    ]);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.deepEqual(captured.scope, [
      'abilities:read', 'abilities:write',
      'abilities:multisite:read', 'abilities:multisite:write',
      'abilities:settings:read', 'abilities:fluent-cart:read',
    ], 'existing first, new appended in input order, abilities:read deduped');
    const cfg = h.readConfig();
    assert.deepEqual(cfg.sites.helena.auth.scopes, captured.scope,
      'persisted scopes reflect the merged set (stub returns scopes === requested)');
  });

  it('--remove-scope drops scopes by exact match; missing scopes are warning-only', async () => {
    const r = await h.runCli('reauth', [
      'helena',
      '--remove-scope=abilities:multisite:read,abilities:nonexistent',
    ]);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.deepEqual(captured.scope, [
      'abilities:read', 'abilities:write',
      'abilities:multisite:write',
    ]);
    const errOut = r.errLines.join('\n');
    assert.match(errOut, /--remove-scope.*"abilities:nonexistent".*not in the existing scope set/);
    assert.doesNotMatch(errOut, /multisite:read.*not in/,
      'scopes that ARE removed should not produce a missing-scope warning');
  });

  it('--scope replace warns when supplied set is a strict subset of existing', async () => {
    const r = await h.runCli('reauth', [
      'helena',
      '--scope=abilities:read,abilities:write',
    ]);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.deepEqual(captured.scope, ['abilities:read', 'abilities:write']);
    const errOut = r.errLines.join('\n');
    assert.match(errOut, /--scope replaces 4 existing scopes with 2 new ones/);
    assert.match(errOut, /Use --add-scope to merge instead/);
  });

  it('--scope replace does NOT warn when supplied set adds new scopes (not subset)', async () => {
    const r = await h.runCli('reauth', [
      'helena',
      '--scope=abilities:read,abilities:write,abilities:editorial:read',
    ]);
    assert.equal(r.exitCode, 0, r.errLines.join('\n'));
    assert.deepEqual(captured.scope, ['abilities:read', 'abilities:write', 'abilities:editorial:read']);
    assert.equal(r.errLines.length, 0,
      'replace that adds new scopes is intentional set-swap — no advisory');
  });

  it('combining --scope and --add-scope errors with typed message before OAuth runs', async () => {
    const r = await h.runCli('reauth', [
      'helena',
      '--scope=abilities:read',
      '--add-scope=abilities:write',
    ]);
    assert.equal(r.exitCode, 2, r.lines.join('\n'));
    assert.equal(captured, null, 'OAuthClient must not be constructed when flags conflict');
    const errOut = r.errLines.join('\n');
    assert.match(errOut, /--scope, --add-scope are mutually exclusive/);
    assert.match(errOut, /each flag does one job/);
  });

  it('combining --add-scope and --remove-scope errors with typed message', async () => {
    const r = await h.runCli('reauth', [
      'helena',
      '--add-scope=abilities:editorial:read',
      '--remove-scope=abilities:multisite:read',
    ]);
    assert.equal(r.exitCode, 2);
    assert.equal(captured, null);
    assert.match(r.errLines.join('\n'), /--add-scope, --remove-scope are mutually exclusive/);
  });
});

