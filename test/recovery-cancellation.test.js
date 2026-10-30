'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { OAuthHttpTransport } = require('../lib/transports/oauth-http-transport');
const { discover } = require('../lib/auth/discovery-client');

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function makeServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function recoveryTransport(endpoint, tokenManager, signal) {
  return new OAuthHttpTransport({
    endpoint,
    tokenManager,
    siteAuth: { siteId: 'siteA', credentialGeneration: 'generation-1' },
    recovery: { signal },
    logger: () => {},
  });
}

function waitFor(check, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe('OAuth staged-recovery cancellation (#125)', () => {
  it('aborts a real trickle resource socket and waits for its queue to settle', async () => {
    let received = 0;
    let aborted = 0;
    const { url } = await makeServer((req) => {
      received += 1;
      req.on('aborted', () => { aborted += 1; });
      // Intentionally never respond: cancellation must destroy the real socket.
    });
    const controller = new AbortController();
    const transport = recoveryTransport(url, { async getAccessToken() { return { accessToken: 'token' }; } }, controller.signal);
    await transport.connect();
    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await waitFor(() => received === 1);

    controller.abort();
    await transport.shutdown();
    await waitFor(() => aborted === 1);
    assert.equal(transport.processing, false);
    assert.equal(transport._activeRecoveryRequests.size, 0);
  });

  it('does not make a resource request after a cancelled token read later settles', async () => {
    let resolveToken;
    const tokenRead = new Promise((resolve) => { resolveToken = resolve; });
    let received = 0;
    const { url } = await makeServer(() => { received += 1; });
    const controller = new AbortController();
    const transport = recoveryTransport(url, {
      async getAccessToken() { return tokenRead; },
    }, controller.signal);
    await transport.connect();
    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    await waitFor(() => transport.processing === true);

    controller.abort();
    resolveToken({ accessToken: 'token' });
    await transport.shutdown();
    assert.equal(received, 0, 'a settled credential read cannot trigger a later resource POST');
  });

  it('cancels a retry timer so no second resource request is made', async () => {
    let received = 0;
    const { url } = await makeServer((_req, res) => {
      received += 1;
      res.statusCode = 503;
      res.end('temporary failure');
    });
    const controller = new AbortController();
    const transport = recoveryTransport(url, { async getAccessToken() { return { accessToken: 'token' }; } }, controller.signal);
    transport.baseRetryDelay = 100;
    await transport.connect();
    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }));
    await waitFor(() => received === 1);
    controller.abort();
    await transport.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received, 1, 'cancelled recovery cannot send a retry/probe');
  });

  it('aborts a real discovery socket without advancing to another probe', async () => {
    let received = 0;
    let aborted = 0;
    const { url } = await makeServer((req) => {
      received += 1;
      req.on('aborted', () => { aborted += 1; });
    });
    const controller = new AbortController();
    const pending = discover(url, { allowInsecure: true, signal: controller.signal });
    await waitFor(() => received === 1);
    controller.abort();
    await assert.rejects(pending, { code: 'discovery_cancelled' });
    await waitFor(() => aborted === 1);
    assert.equal(received, 1, 'aborted discovery does not issue a later probe');
  });
});
