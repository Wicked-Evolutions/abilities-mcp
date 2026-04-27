'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { FreshEachTimeIdentityProvider } = require('../../lib/auth/fresh-each-time-identity');
const { MemorySecretStore } = require('../../lib/auth/memory-secret-store');

describe('FreshEachTimeIdentityProvider — Appendix H.3.2 contract', () => {
  it('getClientId always returns null, even after persistClientId', async () => {
    const store = new MemorySecretStore();
    const idp = new FreshEachTimeIdentityProvider({ store });
    await idp.persistClientId('siteA', 'client-12345');
    assert.equal(await idp.getClientId('siteA'), null);
  });

  it('persistClientId is a NO-OP — does NOT write to keychain (H.3.2 binding)', async () => {
    const store = new MemorySecretStore();
    const idp = new FreshEachTimeIdentityProvider({ store });
    await idp.persistClientId('siteA', 'client-12345');
    // The keychain must remain empty — H.3.2 explicitly forbids writing
    // client_id in v1.0.
    const all = await store.findAll('abilities-mcp');
    assert.deepEqual(all, []);
  });

  it('clearClientId is a NO-OP and does not throw', async () => {
    const idp = new FreshEachTimeIdentityProvider();
    await idp.clearClientId('siteA'); // should resolve cleanly
  });

  it('exportIdentity returns null', async () => {
    const idp = new FreshEachTimeIdentityProvider();
    assert.equal(await idp.exportIdentity('siteA'), null);
  });

  it('importIdentity throws not_implemented', async () => {
    const idp = new FreshEachTimeIdentityProvider();
    await assert.rejects(
      idp.importIdentity('siteA', { version: 1, siteId: 'siteA', clientId: 'x', exportedAt: 'now' }),
      /not supported in v1.0/
    );
  });
});
