'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { OAuthClient, DEFAULT_SCOPE } = require('../../lib/auth/oauth-client');
const { FreshEachTimeIdentityProvider } = require('../../lib/auth/fresh-each-time-identity');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { STATES } = require('../../lib/auth/events');
const { CapabilityPinningError } = require('../../lib/auth/errors');
const { MockAuthServer } = require('./helpers/mock-auth-server');

function newIdp() {
  return new FreshEachTimeIdentityProvider({ store: new MemorySecretStore() });
}

/**
 * Drive the loopback callback by sending a GET to the loopback redirect URI
 * once the state machine reaches `awaiting_consent`.
 */
function autoCompleteFlow(client, code = 'AUTOPASS') {
  const http = require('node:http');
  client.on('awaiting_consent', ({ data }) => {
    const url = new URL(data.authorizeUrl);
    const state = url.searchParams.get('state');
    const cbUrl = `${data.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    setImmediate(() => {
      http.get(cbUrl, (res) => res.resume()).on('error', () => {});
    });
  });
}

describe('OAuthClient — full flow against MockAuthServer', () => {
  let server;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  it('runs through every state in order and emits state events', async () => {
    const client = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test (host.local)',
      softwareVersion: '1.4.0',
      identityProvider: newIdp(),
      allowInsecure: true,
      deps: {
        openBrowser: async () => ({ spawned: true, platform: 'override' }),
      },
    });
    const transitions = [];
    client.on('state', (p) => transitions.push(p.to));
    autoCompleteFlow(client);

    const result = await client.run();

    assert.deepEqual(transitions, [
      STATES.DISCOVERING,
      STATES.REGISTERING,
      STATES.AWAITING_CONSENT,
      STATES.EXCHANGING,
      STATES.COMPLETE,
    ]);
    assert.equal(client.state, STATES.COMPLETE);
    assert.match(result.tokens.access_token, /^at-/);
    assert.match(result.clientId, /^client-/);
    assert.deepEqual(result.scopes, ['abilities:read', 'abilities:write']);
    assert.ok(result.capabilityPin.firstSeenAt);
    assert.equal(result.capabilityPin.firstSeenAt, result.capabilityPin.lastConfirmedAt);
  });

  it('uses default scope when none is supplied', async () => {
    const client = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: newIdp(),
      allowInsecure: true,
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(client);
    const r = await client.run();
    assert.equal(typeof DEFAULT_SCOPE, 'string');
    assert.deepEqual(r.scopes.sort(), ['abilities:read', 'abilities:write'].sort());
  });

  it('preserves capabilityPin.firstSeenAt across reauths', async () => {
    const client = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: newIdp(),
      allowInsecure: true,
      capabilityPin: { firstSeenAt: '2026-01-15T00:00:00.000Z' },
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(client);
    const r = await client.run();
    assert.equal(r.capabilityPin.firstSeenAt, '2026-01-15T00:00:00.000Z');
    assert.notEqual(r.capabilityPin.lastConfirmedAt, '2026-01-15T00:00:00.000Z');
  });

  it('emits failed event and throws when discovery fails on a pinned site (H.2.3)', async () => {
    const downgraded = await new MockAuthServer({ discoveryStatus: 404 }).start();
    try {
      const client = new OAuthClient({
        siteUrl: downgraded.siteUrl,
        clientName: 'Test',
        softwareVersion: '1.4.0',
        identityProvider: newIdp(),
        allowInsecure: true,
        capabilityPin: { firstSeenAt: '2026-01-15T00:00:00.000Z' },
        deps: { openBrowser: async () => ({}) },
      });
      let failedPayload;
      client.on('failed', (p) => { failedPayload = p; });
      await assert.rejects(client.run(), CapabilityPinningError);
      assert.equal(client.state, STATES.FAILED);
      assert.ok(failedPayload && failedPayload.error);
      assert.match(failedPayload.error.message, /previously supported OAuth/);
    } finally {
      await downgraded.stop();
    }
  });

  it('refuses to be re-run after termination', async () => {
    const client = new OAuthClient({
      siteUrl: server.siteUrl,
      clientName: 'Test',
      softwareVersion: '1.4.0',
      identityProvider: newIdp(),
      allowInsecure: true,
      deps: { openBrowser: async () => ({}) },
    });
    autoCompleteFlow(client);
    await client.run();
    await assert.rejects(client.run(), /terminal state/);
  });
});
