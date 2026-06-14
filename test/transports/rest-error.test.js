'use strict';

/**
 * Unit tests for lib/transports/rest-error.js
 *
 * Covers isRestNoRoute: valid rest_no_route JSON, other JSON codes, non-JSON,
 * empty string, and non-string inputs — all edge cases safe on any input.
 *
 * Issue #103 — route-absent terminal detection helper.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isRestNoRoute } = require('../../lib/transports/rest-error');

describe('isRestNoRoute — WordPress rest_no_route detection', () => {
  it('returns true for a valid rest_no_route JSON body', () => {
    assert.equal(
      isRestNoRoute(JSON.stringify({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } })),
      true
    );
  });

  it('returns true for a minimal rest_no_route body (just code)', () => {
    assert.equal(isRestNoRoute('{"code":"rest_no_route"}'), true);
  });

  it('returns false for a different WordPress error code', () => {
    assert.equal(isRestNoRoute('{"code":"rest_forbidden","message":"Sorry, you are not allowed to do that."}'), false);
  });

  it('returns false for a valid JSON body with no code field', () => {
    assert.equal(isRestNoRoute('{"error":"invalid_token"}'), false);
  });

  it('returns false for an empty object', () => {
    assert.equal(isRestNoRoute('{}'), false);
  });

  it('returns false for a JSON array', () => {
    assert.equal(isRestNoRoute('[]'), false);
  });

  it('returns false for non-JSON string', () => {
    assert.equal(isRestNoRoute('Not Found'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isRestNoRoute(''), false);
  });

  it('returns false for null', () => {
    assert.equal(isRestNoRoute(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isRestNoRoute(undefined), false);
  });

  it('returns false for a number', () => {
    assert.equal(isRestNoRoute(404), false);
  });

  it('returns false for an object (not a string)', () => {
    assert.equal(isRestNoRoute({ code: 'rest_no_route' }), false);
  });

  it('returns false for truncated / malformed JSON', () => {
    assert.equal(isRestNoRoute('{"code":"rest_no_route"'), false);
  });
});
