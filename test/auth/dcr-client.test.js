'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { register, buildRegistrationBody, SOFTWARE_ID } = require('../../lib/auth/dcr-client');
const { RegistrationError } = require('../../lib/auth/errors');
const { MockAuthServer } = require('./helpers/mock-auth-server');

describe('dcr-client.buildRegistrationBody', () => {
  it('emits the F.4 forward-compat shape with software_id pinned', () => {
    const body = buildRegistrationBody({
      clientName: "Jacob's Operator (jacobs-laptop.local)",
      redirectUri: 'http://127.0.0.1:51735/callback',
      scope: 'abilities:read abilities:write',
      softwareVersion: '1.4.0',
    });
    assert.equal(body.client_name, "Jacob's Operator (jacobs-laptop.local)");
    assert.deepEqual(body.redirect_uris, ['http://127.0.0.1:51735/callback']);
    assert.equal(body.token_endpoint_auth_method, 'none');
    assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
    assert.deepEqual(body.response_types, ['code']);
    assert.equal(body.scope, 'abilities:read abilities:write');
    assert.equal(body.software_id, SOFTWARE_ID);
    assert.equal(body.software_version, '1.4.0');
    assert.equal(body.client_uri, 'https://wickedevolutions.com/docs/abilities-mcp');
  });
  it('joins array scope with single spaces', () => {
    const body = buildRegistrationBody({
      clientName: 'x',
      redirectUri: 'http://127.0.0.1:1/callback',
      scope: ['abilities:read', 'abilities:write'],
      softwareVersion: '1.4.0',
    });
    assert.equal(body.scope, 'abilities:read abilities:write');
  });
});

describe('dcr-client.register (e2e against MockAuthServer)', () => {
  let server;
  before(async () => { server = await new MockAuthServer().start(); });
  after(async () => { await server.stop(); });

  it('issues a client_id and emits an L2 GET probe before POST', async () => {
    server.events.length = 0;
    const result = await register({
      registrationEndpoint: `${server.origin}/oauth/register`,
      clientName: 'Test',
      redirectUri: 'http://127.0.0.1:51735/callback',
      scope: 'abilities:read abilities:write',
      softwareVersion: '1.4.0',
      allowInsecure: true,
    });
    assert.match(result.clientId, /^client-/);
    // events log should contain a GET before a POST on /oauth/register.
    const regEvents = server.events.filter((e) => e.pathname === '/oauth/register');
    assert.equal(regEvents[0].method, 'GET');
    assert.equal(regEvents[1].method, 'POST');
  });

  it('throws RegistrationError on non-2xx', async () => {
    const broken = await new MockAuthServer({ registerStatus: 500 }).start();
    try {
      await assert.rejects(
        register({
          registrationEndpoint: `${broken.origin}/oauth/register`,
          clientName: 'Test',
          redirectUri: 'http://127.0.0.1:1/callback',
          scope: 'abilities:read',
          softwareVersion: '1.4.0',
          allowInsecure: true,
        }),
        RegistrationError
      );
    } finally {
      await broken.stop();
    }
  });
});
