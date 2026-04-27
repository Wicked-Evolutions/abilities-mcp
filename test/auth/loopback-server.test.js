'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { LoopbackServer, PORT_MIN, PORT_MAX } = require('../../lib/auth/loopback-server');
const { StateMismatchError, UserDeniedError } = require('../../lib/auth/errors');
const { generateState } = require('../../lib/auth/pkce');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

describe('LoopbackServer', () => {
  it('binds on a port within [49152, 65535]', async () => {
    const server = new LoopbackServer({ expectedState: generateState() });
    const { port } = await server.start();
    assert.ok(port >= PORT_MIN && port <= PORT_MAX, `port ${port} out of range`);
    await server.stop();
  });

  it('resolves waitForCallback with valid {code, state}', async () => {
    const expectedState = generateState();
    const server = new LoopbackServer({ expectedState });
    const { redirectUri } = await server.start();

    const callbackPromise = server.waitForCallback({ timeoutMs: 2000 });
    const url = `${redirectUri}?code=AUTHCODE&state=${encodeURIComponent(expectedState)}`;
    const res = await get(url);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Authorization complete/);

    const result = await callbackPromise;
    assert.equal(result.code, 'AUTHCODE');
    assert.equal(result.state, expectedState);
    await server.stop();
  });

  it('rejects with StateMismatchError on bad state (H.4.5)', async () => {
    const server = new LoopbackServer({ expectedState: generateState() });
    const { redirectUri } = await server.start();
    const callbackPromise = server.waitForCallback({ timeoutMs: 2000 });
    // Attach the rejection handler BEFORE driving the HTTP request so the
    // promise is never momentarily rejected without a listener (Node 20+
    // surfaces that as an unhandledRejection).
    const assertion = assert.rejects(callbackPromise, StateMismatchError);
    await get(`${redirectUri}?code=X&state=wrong`);
    await assertion;
    await server.stop();
  });

  it('rejects with UserDeniedError on access_denied', async () => {
    const expectedState = generateState();
    const server = new LoopbackServer({ expectedState });
    const { redirectUri } = await server.start();
    const callbackPromise = server.waitForCallback({ timeoutMs: 2000 });
    const assertion = assert.rejects(callbackPromise, UserDeniedError);
    await get(`${redirectUri}?error=access_denied&state=${expectedState}`);
    await assertion;
    await server.stop();
  });

  it('uses exclusive bind so a second listener on the same port fails', async () => {
    // Pin a specific port via portFn, expect the second start to throw.
    let port;
    const a = new LoopbackServer({
      expectedState: generateState(),
      portFn: () => 50000 + Math.floor(Math.random() * 10000),
    });
    const startedA = await a.start();
    port = startedA.port;

    const b = new LoopbackServer({
      expectedState: generateState(),
      portFn: () => port,
      bindRetries: 0,
    });
    await assert.rejects(b.start(), /failed to bind|EADDRINUSE/i);
    await a.stop();
  });

  it('rejects with timeout error when no callback arrives in window', async () => {
    const server = new LoopbackServer({ expectedState: generateState() });
    await server.start();
    await assert.rejects(
      server.waitForCallback({ timeoutMs: 50 }),
      /timed out/
    );
    await server.stop();
  });
});
