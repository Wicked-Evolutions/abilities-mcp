'use strict';

const { randomBytes, createHash, timingSafeEqual: cryptoTimingSafeEqual } = require('node:crypto');

/**
 * PKCE (RFC 7636) and CSRF state primitives.
 *
 * Per design doc:
 *   - PKCE method MUST be S256 (Appendix D.1, H.3.6, discovery metadata).
 *   - state = bin2hex(random_bytes(16)) → 128 bits of entropy (Appendix H.3.5).
 *   - State comparison on loopback callback uses timingSafeEqual (H.3.5, H.4.5).
 *
 * The verifier byte length is implementer's choice within RFC 7636 (43–128
 * chars after base64url). We use 32 bytes → 43-char base64url string, the
 * common choice.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const VERIFIER_BYTES = 32;       // → 43-char base64url verifier (RFC 7636 §4.1)
const STATE_BYTES = 16;          // → 32-char hex state (128 bits, per H.3.5)
const STATE_MAX_LENGTH = 256;    // server enforces; mirrored here for safety

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Generate a fresh PKCE pair.
 * @returns {{verifier: string, challenge: string, method: 'S256'}}
 */
function generatePkce() {
  const verifierBytes = randomBytes(VERIFIER_BYTES);
  const verifier = base64url(verifierBytes);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/**
 * Compute the S256 challenge for a given verifier — useful for tests.
 * @param {string} verifier
 * @returns {string}
 */
function challengeFromVerifier(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

/**
 * Generate a fresh CSRF state token. 128 bits of entropy, hex-encoded.
 * @returns {string}
 */
function generateState() {
  return randomBytes(STATE_BYTES).toString('hex');
}

/**
 * Constant-time equality check on two strings. Used to compare the loopback
 * callback's `state` query param against the bridge-generated value (H.3.5,
 * H.4.5). Returns false on any error including length mismatch.
 *
 * @param {string} expected
 * @param {string} received
 * @returns {boolean}
 */
function safeStateEquals(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  if (expected.length === 0 || received.length === 0) return false;
  if (expected.length > STATE_MAX_LENGTH || received.length > STATE_MAX_LENGTH) return false;
  if (expected.length !== received.length) {
    // Avoid throwing in timingSafeEqual on length mismatch — but burn a few
    // CPU cycles so timing doesn't trivially leak the length difference.
    const filler = Buffer.alloc(expected.length, 0);
    try { cryptoTimingSafeEqual(filler, filler); } catch { /* ignore */ }
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return cryptoTimingSafeEqual(a, b);
}

module.exports = {
  generatePkce,
  challengeFromVerifier,
  generateState,
  safeStateEquals,
  VERIFIER_BYTES,
  STATE_BYTES,
  STATE_MAX_LENGTH,
};
