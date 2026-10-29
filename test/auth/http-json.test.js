'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { request } = require('../../lib/auth/http-json');

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function localhostLookup(_hostname, opts, done) {
  const callback = typeof opts === 'function' ? opts : done;
  const all = typeof opts === 'object' && !!opts.all;
  callback(null, all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', all ? undefined : 4);
}

describe('http-json delivery classification', () => {
  it('marks only the matching fresh-socket DNS lookup EAI_AGAIN as proven unsent', async () => {
    const seen = [];
    const originalRequest = http.request;
    const dnsError = Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
    http.request = (options, callback) => {
      seen.push(options);
      return originalRequest(options, callback);
    };
    try {
      await assert.rejects(
        request({
          url: 'http://localhost:12345/token', allowInsecure: true, freshSocket: true,
          lookup: (_host, _opts, done) => process.nextTick(() => done(dnsError)),
        }),
        (err) => err === dnsError && err.oauthDelivery === 'proven_not_dispatched'
      );
    } finally {
      http.request = originalRequest;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].agent.options.keepAlive, false, 'fresh requests use a one-shot non-keepalive agent');
  });

  it('keeps EAI_AGAIN ambiguous after a fresh socket connected', async () => {
    const server = await startServer((_req, _res) => {});
    const originalRequest = http.request;
    const postConnect = Object.assign(new Error('synthetic post-connect error'), { code: 'EAI_AGAIN' });
    http.request = (options, callback) => {
      const req = originalRequest(options, callback);
      req.once('socket', (socket) => socket.once('connect', () => req.destroy(postConnect)));
      return req;
    };
    try {
      const port = server.address().port;
      await assert.rejects(
        request({
          url: `http://localhost:${port}/token`, allowInsecure: true, freshSocket: true,
          lookup: localhostLookup,
        }),
        (err) => err === postConnect && err.oauthDelivery === undefined
      );
    } finally {
      http.request = originalRequest;
      await stopServer(server);
    }
  });

  it('keeps EAI_AGAIN ambiguous after a response started', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      setTimeout(() => res.end('{}'), 30);
    });
    const originalRequest = http.request;
    const postResponse = Object.assign(new Error('synthetic response error'), { code: 'EAI_AGAIN' });
    http.request = (options, callback) => originalRequest(options, (res) => {
      callback(res);
      process.nextTick(() => res.emit('error', postResponse));
    });
    try {
      const port = server.address().port;
      await assert.rejects(
        request({
          url: `http://localhost:${port}/token`, allowInsecure: true, freshSocket: true,
          lookup: localhostLookup,
        }),
        (err) => err === postResponse && err.oauthDelivery === undefined
      );
    } finally {
      http.request = originalRequest;
      await stopServer(server);
    }
  });

  it('keeps non-DNS failures ambiguous', async () => {
    const reset = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const server = await startServer((_req, _res) => {});
    const originalRequest = http.request;
    http.request = (options, callback) => {
      const req = originalRequest(options, callback);
      req.once('socket', () => process.nextTick(() => req.destroy(reset)));
      return req;
    };
    try {
      const port = server.address().port;
      await assert.rejects(
        request({
          url: `http://localhost:${port}/token`, allowInsecure: true, freshSocket: true,
          lookup: localhostLookup,
        }),
        (err) => err === reset && err.oauthDelivery === undefined
      );
    } finally {
      http.request = originalRequest;
      await stopServer(server);
    }
  });
});
