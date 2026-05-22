'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { buildProbeOrder, discover, validateAsMetadata } = require('../../lib/auth/discovery-client');
const { CapabilityPinningError, DiscoveryError } = require('../../lib/auth/errors');
const { MockAuthServer } = require('./helpers/mock-auth-server');

describe('discovery-client.buildProbeOrder (Appendix D.2 L1)', () => {
  it('produces three probe URLs for a path-style issuer', () => {
    const { authorizationServer } = buildProbeOrder('https://example.com/site2');
    assert.deepEqual(authorizationServer, [
      'https://example.com/.well-known/oauth-authorization-server/site2',
      'https://example.com/.well-known/openid-configuration/site2',
      'https://example.com/site2/.well-known/openid-configuration',
    ]);
  });
  it('de-dupes when the issuer has no path', () => {
    const { authorizationServer } = buildProbeOrder('https://example.com');
    // The 1st and 3rd only collapse when path is empty AND the server treats
    // them identically — for an empty pathPart, candidate 1 and 3 differ in
    // the position of `.well-known`, but candidate 2 and 3 collapse.
    assert.equal(new Set(authorizationServer).size, authorizationServer.length);
  });
});

describe('discovery-client.validateAsMetadata', () => {
  it('rejects when issuer is missing', () => {
    const r = validateAsMetadata({ token_endpoint: 't' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /issuer/);
  });
  it('rejects when S256 is not advertised', () => {
    const r = validateAsMetadata({
      issuer: 'i',
      authorization_endpoint: 'a',
      token_endpoint: 't',
      code_challenge_methods_supported: ['plain'],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /S256/);
  });
  it('accepts a minimum valid metadata document', () => {
    assert.deepEqual(validateAsMetadata({
      issuer: 'i', authorization_endpoint: 'a', token_endpoint: 't',
    }), { ok: true });
  });
});

describe('discovery-client.discover (e2e against MockAuthServer)', () => {
  let server;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  it('discovers metadata over loopback when allowInsecure is set', async () => {
    const result = await discover(server.siteUrl, { allowInsecure: true });
    assert.equal(typeof result.asMetadata.issuer, 'string');
    assert.equal(result.asMetadata.token_endpoint, `${server.origin}/oauth/token`);
    assert.equal(result.prMetadata.resource, `${server.origin}/wp-json/mcp/abilities-mcp-adapter-default-server`);
  });

  it('refuses HTTP discovery for non-loopback hosts (HTTPS-only per H.2.3)', async () => {
    await assert.rejects(
      discover('http://example.com'),
      /HTTPS required/i
    );
  });

  it('throws DiscoveryError when no probe returns valid metadata', async () => {
    const broken = await new MockAuthServer({ discoveryStatus: 500 }).start();
    try {
      await assert.rejects(
        discover(broken.siteUrl, { allowInsecure: true }),
        DiscoveryError
      );
    } finally {
      await broken.stop();
    }
  });

  it('throws CapabilityPinningError when pinned site returns 404 (H.2.3)', async () => {
    const downgraded = await new MockAuthServer({ discoveryStatus: 404 }).start();
    try {
      await assert.rejects(
        discover(downgraded.siteUrl, {
          allowInsecure: true,
          pinned: true,
          pinnedFirstSeenAt: '2026-01-15T00:00:00Z',
        }),
        CapabilityPinningError
      );
    } finally {
      await downgraded.stop();
    }
  });
});
