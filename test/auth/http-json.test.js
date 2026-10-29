'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { request } = require('../../lib/auth/http-json');

function withRequestStub(stub, fn) {
  const original = http.request;
  http.request = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => { http.request = original; });
}

function failingRequest(error, seen) {
  return (options) => {
    seen.push(options);
    return {
      on(event, callback) {
        if (event === 'error') process.nextTick(() => callback(error));
        return this;
      },
      end() {},
    };
  };
}

describe('http-json delivery classification', () => {
  it('marks EAI_AGAIN as proven unsent only on a fresh socket', async () => {
    const seen = [];
    const error = Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
    await withRequestStub(failingRequest(error, seen), async () => {
      await assert.rejects(
        request({ url: 'http://localhost:12345/token', allowInsecure: true, freshSocket: true }),
        (err) => err.oauthDelivery === 'proven_not_dispatched'
      );
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].agent, false, 'fresh requests disable connection reuse');
  });

  it('keeps non-DNS and pooled-socket failures ambiguous', async () => {
    const reset = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    await withRequestStub(failingRequest(reset, []), async () => {
      await assert.rejects(
        request({ url: 'http://localhost:12345/token', allowInsecure: true, freshSocket: true }),
        (err) => err.oauthDelivery === undefined
      );
    });
    const dns = Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
    await withRequestStub(failingRequest(dns, []), async () => {
      await assert.rejects(
        request({ url: 'http://localhost:12345/token', allowInsecure: true }),
        (err) => err.oauthDelivery === undefined
      );
    });
  });
});
