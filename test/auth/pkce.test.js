'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const {
  generatePkce,
  challengeFromVerifier,
  generateState,
  safeStateEquals,
  STATE_BYTES,
} = require('../../lib/auth/pkce');

describe('pkce.generatePkce', () => {
  it('returns S256 verifier and challenge that match RFC 7636', () => {
    const { verifier, challenge, method } = generatePkce();
    assert.equal(method, 'S256');
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
    // 32 random bytes → 43-char base64url
    assert.equal(verifier.length, 43);
    const expected = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    assert.equal(challenge, expected);
  });

  it('produces unique verifiers across calls', () => {
    const a = generatePkce();
    const b = generatePkce();
    assert.notEqual(a.verifier, b.verifier);
  });
});

describe('pkce.challengeFromVerifier', () => {
  it('matches the canonical RFC 7636 example', () => {
    // RFC 7636 §4.6 sample verifier and S256 challenge
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    assert.equal(challengeFromVerifier(verifier), challenge);
  });
});

describe('pkce.generateState', () => {
  it('returns hex string of expected length', () => {
    const s = generateState();
    assert.equal(s.length, STATE_BYTES * 2);
    assert.match(s, /^[0-9a-f]+$/);
  });
});

describe('pkce.safeStateEquals', () => {
  it('returns true on exact match', () => {
    const s = generateState();
    assert.equal(safeStateEquals(s, s), true);
  });
  it('returns false on mismatch', () => {
    const a = generateState();
    const b = generateState();
    assert.equal(safeStateEquals(a, b), false);
  });
  it('returns false on length mismatch without throwing', () => {
    assert.equal(safeStateEquals('abc', 'abcd'), false);
  });
  it('returns false for empty strings', () => {
    assert.equal(safeStateEquals('', ''), false);
    assert.equal(safeStateEquals('abc', ''), false);
  });
  it('returns false for non-string input', () => {
    assert.equal(safeStateEquals(null, 'abc'), false);
    assert.equal(safeStateEquals('abc', null), false);
    assert.equal(safeStateEquals(undefined, undefined), false);
  });
  it('rejects pathologically long input', () => {
    const long = 'x'.repeat(1000);
    assert.equal(safeStateEquals(long, long), false);
  });
});
