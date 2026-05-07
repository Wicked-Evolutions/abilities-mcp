'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { makeRef, parseRef, resolveRef } = require('../../lib/auth/secret-store');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');
const { KeychainSecretStore } = require('../../lib/auth/keychain-secret-store');

describe('SecretStore reference helpers', () => {
  it('makeRef builds keychain://service/account', () => {
    assert.equal(makeRef('abilities-mcp', 'siteA/access'), 'keychain://abilities-mcp/siteA/access');
  });
  it('parseRef round-trips through makeRef', () => {
    const ref = makeRef('abilities-mcp', 'siteB/refresh');
    assert.deepEqual(parseRef(ref), { service: 'abilities-mcp', account: 'siteB/refresh' });
  });
  it('parseRef supports nested account paths', () => {
    const ref = makeRef('abilities-mcp', 'siteC/apppassword-legacy');
    assert.deepEqual(parseRef(ref), { service: 'abilities-mcp', account: 'siteC/apppassword-legacy' });
  });
  it('parseRef rejects unscheme strings', () => {
    assert.throws(() => parseRef('abilities-mcp/foo'), /Not a keychain reference/);
  });
  it('parseRef rejects malformed strings', () => {
    assert.throws(() => parseRef('keychain://abilities-mcp'), /Malformed/);
  });
});

describe('MemorySecretStore', () => {
  it('round-trips set/get/delete', async () => {
    const store = new MemorySecretStore();
    await store.set('s', 'a', 'secret-a');
    assert.equal(await store.get('s', 'a'), 'secret-a');
    assert.equal(await store.delete('s', 'a'), true);
    assert.equal(await store.get('s', 'a'), null);
  });
  it('findAll returns entries scoped to a service', async () => {
    const store = new MemorySecretStore();
    await store.set('abilities-mcp', 'siteA/access', 'AT');
    await store.set('abilities-mcp', 'siteA/refresh', 'RT');
    await store.set('other', 'siteA/access', 'NO');
    const found = await store.findAll('abilities-mcp');
    const accounts = found.map((f) => f.account).sort();
    assert.deepEqual(accounts, ['siteA/access', 'siteA/refresh']);
  });
  it('rejects non-string secrets', async () => {
    const store = new MemorySecretStore();
    await assert.rejects(store.set('s', 'a', 123), /must be a string/);
  });
});

describe('resolveRef', () => {
  it('returns the secret for a valid ref', async () => {
    const store = new MemorySecretStore();
    await store.set('abilities-mcp', 'siteA/access', 'AT');
    const v = await resolveRef(store, makeRef('abilities-mcp', 'siteA/access'));
    assert.equal(v, 'AT');
  });
  it('throws when not found', async () => {
    const store = new MemorySecretStore();
    await assert.rejects(
      resolveRef(store, makeRef('abilities-mcp', 'siteA/access')),
      /not found/
    );
  });
});

describe('KeychainSecretStore (with stub)', () => {
  function stubKeytar() {
    const store = new Map();
    return {
      async getPassword(s, a) { return store.has(`${s}|${a}`) ? store.get(`${s}|${a}`) : null; },
      async setPassword(s, a, v) { store.set(`${s}|${a}`, v); },
      async deletePassword(s, a) { return store.delete(`${s}|${a}`); },
      async findCredentials(s) {
        const out = [];
        for (const [k, v] of store) {
          if (k.startsWith(`${s}|`)) out.push({ account: k.slice(s.length + 1), password: v });
        }
        return out;
      },
    };
  }

  it('round-trips through an injected keytar-shaped object', async () => {
    // backend: 'keytar' opts out of the #61 darwin-default security-CLI path
    // so the injected keytar is actually exercised on every CI platform.
    const store = new KeychainSecretStore({ keytar: stubKeytar(), backend: 'keytar' });
    await store.set('abilities-mcp', 'siteA/access', 'AT');
    assert.equal(await store.get('abilities-mcp', 'siteA/access'), 'AT');
    await store.delete('abilities-mcp', 'siteA/access');
    assert.equal(await store.get('abilities-mcp', 'siteA/access'), null);
  });

  it('isAvailable() is true with injected keytar', async () => {
    const store = new KeychainSecretStore({ keytar: stubKeytar(), backend: 'keytar' });
    assert.equal(await store.isAvailable(), true);
  });
});
