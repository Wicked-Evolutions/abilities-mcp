'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validate, emptyConfig, SCHEMA_VERSION } = require('../../lib/auth/schema-v2');

describe('schema-v2.validate', () => {
  it('accepts a minimal OAuth site (Appendix F.5 shape)', () => {
    const config = {
      schema_version: SCHEMA_VERSION,
      sites: {
        siteA: {
          url: 'https://siteA.com',
          auth: {
            method: 'oauth',
            client_id: 'cid',
            access_token_ref: 'keychain://abilities-mcp/siteA/access',
            refresh_token_ref: 'keychain://abilities-mcp/siteA/refresh',
          },
          auth_status: 'active',
        },
      },
    };
    assert.deepEqual(validate(config), { ok: true });
  });

  it('accepts a minimal apppassword site', () => {
    const config = {
      schema_version: SCHEMA_VERSION,
      sites: {
        siteB: {
          url: 'https://siteB.com',
          auth: { method: 'apppassword', username: 'u', password_ref: 'keychain://abilities-mcp/siteB/apppassword' },
          auth_status: 'active',
        },
      },
    };
    assert.deepEqual(validate(config), { ok: true });
  });

  it('rejects unknown schema_version', () => {
    const result = validate({ schema_version: 1, sites: {} });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /schema_version must be 2/);
  });

  it('rejects unknown auth method', () => {
    const result = validate({
      schema_version: SCHEMA_VERSION,
      sites: { siteA: { url: 'https://siteA.com', auth: { method: 'magic' } } },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /method must be one of/);
  });

  it('rejects unknown auth_status', () => {
    const result = validate({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteA: {
          url: 'https://siteA.com',
          auth: { method: 'apppassword', username: 'u', password_ref: 'k' },
          auth_status: 'wat',
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /auth_status must be one of/);
  });

  it('requires OAuth fields when method is oauth', () => {
    const result = validate({
      schema_version: SCHEMA_VERSION,
      sites: { siteA: { url: 'https://siteA.com', auth: { method: 'oauth' } } },
    });
    assert.equal(result.ok, false);
    const all = result.errors.join('\n');
    assert.match(all, /client_id is required/);
    assert.match(all, /access_token_ref is required/);
    assert.match(all, /refresh_token_ref is required/);
  });

  it('validates oauth_capability_pinned shape', () => {
    const result = validate({
      schema_version: SCHEMA_VERSION,
      sites: {
        siteA: {
          url: 'https://siteA.com',
          auth: {
            method: 'oauth',
            client_id: 'c',
            access_token_ref: 'k1',
            refresh_token_ref: 'k2',
          },
          oauth_capability_pinned: { first_seen_at: 'now' }, // missing last_confirmed_at
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /oauth_capability_pinned/);
  });
});

describe('schema-v2.emptyConfig', () => {
  it('produces a v2-shaped skeleton', () => {
    const c = emptyConfig({ defaultSite: 'siteA' });
    assert.equal(c.schema_version, SCHEMA_VERSION);
    assert.equal(c.defaultSite, 'siteA');
    assert.deepEqual(c.sites, {});
  });
});
