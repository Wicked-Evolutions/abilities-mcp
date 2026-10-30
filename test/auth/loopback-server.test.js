'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { LoopbackServer } = require('../../lib/auth/loopback-server');
const { AuthError, StateMismatchError, UserDeniedError } = require('../../lib/auth/errors');
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
  it('uses a positive OS-assigned loopback port', async () => {
    const server = new LoopbackServer({ expectedState: generateState() });
    const { port } = await server.start();
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, `invalid assigned port ${port}`);
    assert.equal(new URL(server.redirectUri).port, String(port));
    await server.stop();
  });

  it('allocates distinct ports for concurrent listeners and releases each port on stop', async () => {
    const a = new LoopbackServer({ expectedState: generateState() });
    const b = new LoopbackServer({ expectedState: generateState() });
    const [first, second] = await Promise.all([a.start(), b.start()]);
    assert.notEqual(first.port, second.port);
    await Promise.all([a.stop(), b.stop()]);

    const reusable = http.createServer();
    await new Promise((resolve, reject) => {
      reusable.once('error', reject);
      reusable.listen({ host: '127.0.0.1', port: first.port, exclusive: true }, resolve);
    });
    await new Promise((resolve) => reusable.close(resolve));
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

  it('rejects an explicitly occupied exact port without changing its listener', async () => {
    const a = new LoopbackServer({ expectedState: generateState() });
    const startedA = await a.start();
    const b = new LoopbackServer({ expectedState: generateState() });
    await assert.rejects(b._listen(startedA.port), (error) => error && error.code === 'EADDRINUSE');
    assert.equal(a.redirectUri, `http://127.0.0.1:${startedA.port}/callback`);
    await a.stop();
  });

  it('reports one safe typed bind failure when the assigned port is invalid', async () => {
    const fakeServer = new EventEmitter();
    fakeServer.listen = (_options, callback) => callback();
    fakeServer.address = () => ({ port: 0 });
    fakeServer.close = (callback) => callback();
    const server = new LoopbackServer({
      expectedState: generateState(),
      serverFactory: () => fakeServer,
    });
    await assert.rejects(server.start(), (error) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, 'loopback_bind_failed');
      assert.equal(error.attempts, 1);
      assert.deepEqual(error.cause, { code: 'loopback_invalid_port' });
      return true;
    });
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
