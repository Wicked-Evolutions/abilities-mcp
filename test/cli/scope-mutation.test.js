'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseScopeList,
  mergeScopes,
  removeScopes,
  isStrictSubset,
  computeScopeMutation,
} = require('../../lib/cli/scope-mutation');

/**
 * Pure helpers for scope-set mutation backing the reauth --add-scope /
 * --remove-scope / --scope flag triad (Issue #50).
 *
 * The CLI tests in reauth.test.js cover the wiring; this file covers the
 * algebra exhaustively so a regression in dedupe / subset detection /
 * no-op-removal warning surfaces here, before it surfaces in user-visible
 * CLI behavior.
 */

describe('parseScopeList', () => {
  it('returns [] for null / undefined / empty string', () => {
    assert.deepEqual(parseScopeList(null), []);
    assert.deepEqual(parseScopeList(undefined), []);
    assert.deepEqual(parseScopeList(''), []);
  });

  it('splits on commas', () => {
    assert.deepEqual(parseScopeList('a,b,c'), ['a', 'b', 'c']);
  });

  it('splits on whitespace', () => {
    assert.deepEqual(parseScopeList('a b  c'), ['a', 'b', 'c']);
  });

  it('splits on mixed commas + whitespace', () => {
    assert.deepEqual(parseScopeList('a, b,c d'), ['a', 'b', 'c', 'd']);
  });

  it('passes through array input with dedupe', () => {
    assert.deepEqual(parseScopeList(['a', 'b', 'a', 'c']), ['a', 'b', 'c']);
  });

  it('preserves order of first occurrence on dedupe', () => {
    assert.deepEqual(parseScopeList('c,a,b,a,c'), ['c', 'a', 'b']);
  });

  it('trims whitespace around tokens', () => {
    assert.deepEqual(parseScopeList(' a , b , c '), ['a', 'b', 'c']);
  });
});

describe('mergeScopes', () => {
  it('appends additions in input order, preserving existing order', () => {
    assert.deepEqual(mergeScopes(['a', 'b'], ['c', 'd']), ['a', 'b', 'c', 'd']);
  });

  it('dedupes additions already in existing', () => {
    assert.deepEqual(mergeScopes(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  });

  it('handles empty existing', () => {
    assert.deepEqual(mergeScopes([], ['a', 'b']), ['a', 'b']);
  });

  it('handles empty additions', () => {
    assert.deepEqual(mergeScopes(['a', 'b'], []), ['a', 'b']);
  });

  it('accepts string inputs (CLI shape)', () => {
    assert.deepEqual(mergeScopes('a,b', 'b,c'), ['a', 'b', 'c']);
  });
});

describe('removeScopes', () => {
  it('removes by exact match, preserving order of remaining', () => {
    const r = removeScopes(['a', 'b', 'c', 'd'], ['b', 'd']);
    assert.deepEqual(r.result, ['a', 'c']);
    assert.deepEqual(r.missing, []);
  });

  it('reports missing scopes (no-op warn-not-error)', () => {
    const r = removeScopes(['a', 'b'], ['b', 'x']);
    assert.deepEqual(r.result, ['a']);
    assert.deepEqual(r.missing, ['x']);
  });

  it('all-missing removals are all-no-op', () => {
    const r = removeScopes(['a', 'b'], ['x', 'y']);
    assert.deepEqual(r.result, ['a', 'b']);
    assert.deepEqual(r.missing, ['x', 'y']);
  });

  it('handles empty existing (everything is missing)', () => {
    const r = removeScopes([], ['a']);
    assert.deepEqual(r.result, []);
    assert.deepEqual(r.missing, ['a']);
  });
});

describe('isStrictSubset', () => {
  it('true when replacement misses elements of existing', () => {
    assert.equal(isStrictSubset(['a'], ['a', 'b', 'c']), true);
  });

  it('false when replacement equals existing', () => {
    // Equal sets — no warning needed (replace is a no-op).
    assert.equal(isStrictSubset(['a', 'b'], ['a', 'b']), false);
  });

  it('false when replacement adds new scopes (not subset)', () => {
    assert.equal(isStrictSubset(['a', 'd'], ['a', 'b', 'c']), false);
  });

  it('false when replacement is larger than existing', () => {
    assert.equal(isStrictSubset(['a', 'b', 'c', 'd'], ['a', 'b']), false);
  });

  it('handles empty replacement against non-empty existing', () => {
    // [] ⊊ [a,b] — every element of [] is trivially in [a,b], and existing has elements not in [].
    assert.equal(isStrictSubset([], ['a', 'b']), true);
  });

  it('handles empty existing — nothing can be a strict subset', () => {
    assert.equal(isStrictSubset(['a'], []), false);
    assert.equal(isStrictSubset([], []), false);
  });
});

describe('computeScopeMutation', () => {
  it('no flags → returns existing scopes, no warnings', () => {
    const r = computeScopeMutation({ existing: ['a', 'b'] });
    assert.deepEqual(r.scopes, ['a', 'b']);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.errorCode, undefined);
  });

  it('--add-scope merges into existing', () => {
    const r = computeScopeMutation({ addScope: 'c,d', existing: ['a', 'b'] });
    assert.deepEqual(r.scopes, ['a', 'b', 'c', 'd']);
    assert.deepEqual(r.warnings, []);
  });

  it('--add-scope dedupes against existing (no double-listing)', () => {
    const r = computeScopeMutation({ addScope: 'b,c', existing: ['a', 'b'] });
    assert.deepEqual(r.scopes, ['a', 'b', 'c']);
  });

  it('--remove-scope drops by exact match', () => {
    const r = computeScopeMutation({ removeScope: 'b', existing: ['a', 'b', 'c'] });
    assert.deepEqual(r.scopes, ['a', 'c']);
    assert.deepEqual(r.warnings, []);
  });

  it('--remove-scope on missing scope warns but does not error', () => {
    const r = computeScopeMutation({ removeScope: 'b,x', existing: ['a', 'b'] });
    assert.deepEqual(r.scopes, ['a']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /--remove-scope.*"x".*not in the existing scope set.*no-op/);
    assert.equal(r.errorCode, undefined,
      'missing-scope removal must be a warning, not an error (per acceptance gate)');
  });

  it('--scope replace warns when supplied set is a strict subset of existing', () => {
    const r = computeScopeMutation({
      scope: 'abilities:read,abilities:write',
      existing: ['abilities:read', 'abilities:write', 'abilities:settings:read', 'abilities:fluent-cart:read'],
    });
    assert.deepEqual(r.scopes, ['abilities:read', 'abilities:write']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /--scope replaces 4 existing scopes with 2 new ones/);
    assert.match(r.warnings[0], /drops 2 scopes/);
    assert.match(r.warnings[0], /Use --add-scope to merge instead/);
  });

  it('--scope replace does NOT warn when supplied set equals existing', () => {
    const r = computeScopeMutation({
      scope: 'a,b',
      existing: ['a', 'b'],
    });
    assert.deepEqual(r.scopes, ['a', 'b']);
    assert.deepEqual(r.warnings, []);
  });

  it('--scope replace does NOT warn when adding new scopes (not subset)', () => {
    const r = computeScopeMutation({
      scope: 'c,d',
      existing: ['a', 'b'],
    });
    assert.deepEqual(r.scopes, ['c', 'd']);
    assert.deepEqual(r.warnings, []);
  });

  it('mutual exclusion — --scope + --add-scope errors with typed message', () => {
    const r = computeScopeMutation({
      scope: 'a',
      addScope: 'b',
      existing: ['x'],
    });
    assert.equal(r.errorCode, 'reauth_scope_flag_conflict');
    assert.match(r.errorMessage, /--scope, --add-scope are mutually exclusive/);
    assert.match(r.errorMessage, /each flag does one job/);
  });

  it('mutual exclusion — all three flags together', () => {
    const r = computeScopeMutation({
      scope: 'a',
      addScope: 'b',
      removeScope: 'c',
      existing: ['x'],
    });
    assert.equal(r.errorCode, 'reauth_scope_flag_conflict');
    assert.match(r.errorMessage, /--scope, --add-scope, --remove-scope/);
  });

  it('mutual exclusion — --add-scope + --remove-scope', () => {
    const r = computeScopeMutation({
      addScope: 'a',
      removeScope: 'b',
      existing: ['x'],
    });
    assert.equal(r.errorCode, 'reauth_scope_flag_conflict');
    assert.match(r.errorMessage, /--add-scope, --remove-scope/);
  });

  it('treats empty string as "not set" for mutual-exclusion check', () => {
    // An operator passing --add-scope= (empty value) should not trigger
    // the conflict path against another empty-string flag.
    const r = computeScopeMutation({
      scope: '',
      addScope: 'b',
      existing: ['x'],
    });
    assert.equal(r.errorCode, undefined);
    assert.deepEqual(r.scopes, ['x', 'b']);
  });

  it('--add-scope with no existing falls back to additions only', () => {
    const r = computeScopeMutation({ addScope: 'a,b' });
    assert.deepEqual(r.scopes, ['a', 'b']);
  });
});
