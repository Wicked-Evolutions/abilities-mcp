'use strict';

/**
 * Scope-mutation helpers for `reauth` (Issue #50).
 *
 * The `reauth` CLI used to accept a single `--scope` flag that REPLACED the
 * persisted scope array — a UX trap, since an operator (or AI assistant)
 * adding new scopes via `--scope='<new only>'` would silently drop every
 * existing scope. The locked design adds `--add-scope` and `--remove-scope`
 * for the merge / remove cases and keeps `--scope` as the explicit-replace
 * escape hatch with a stderr warning when the supplied set is a strict
 * subset of the existing scopes (i.e., the replace would drop scopes).
 *
 * All three flags are mutually exclusive — combining any two is a typed
 * error. Mirrors `git remote add` / `git remote remove` conventions: each
 * flag has one job.
 *
 * This module is pure — no I/O, no logging. The reauth command imports it
 * and threads warnings through the run-contract's `errLines`.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

/**
 * Parse a CLI scope-list value into a deduped array, preserving order of
 * first occurrence. Accepts:
 *   - already-parsed string array (passes through with dedupe)
 *   - comma- or whitespace-delimited string ('a,b c d' → ['a','b','c','d'])
 *   - empty / nullish input → []
 */
function parseScopeList(input) {
  if (input == null || input === '') return [];
  const tokens = Array.isArray(input)
    ? input
    : String(input).split(/[,\s]+/);
  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    const tok = String(t).trim();
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Return existing ∪ additions, deduped, preserving the order
 * "existing first, new additions appended in input order."
 */
function mergeScopes(existing, additions) {
  const e = parseScopeList(existing);
  const a = parseScopeList(additions);
  const seen = new Set(e);
  const out = e.slice();
  for (const tok of a) {
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/**
 * Return { result, missing } where:
 *   result  = existing minus removals (preserves order of existing)
 *   missing = removals that weren't in existing (no-op, warn-not-error)
 */
function removeScopes(existing, removals) {
  const e = parseScopeList(existing);
  const r = parseScopeList(removals);
  const removeSet = new Set(r);
  const existingSet = new Set(e);
  const result = e.filter((tok) => !removeSet.has(tok));
  const missing = r.filter((tok) => !existingSet.has(tok));
  return { result, missing };
}

/**
 * True iff replacement ⊊ existing (every replacement element is in existing
 * AND existing has at least one element not in replacement). Used to detect
 * the --scope replace footgun: supplied set is missing scopes the operator
 * almost certainly didn't mean to drop.
 *
 * Equal sets return false (no warning needed — replace is a no-op).
 * Replacement that adds new scopes (not subset) returns false — operator
 * is intentionally swapping the set.
 */
function isStrictSubset(replacement, existing) {
  const r = parseScopeList(replacement);
  const e = parseScopeList(existing);
  if (r.length >= e.length) return false; // strict subset must be smaller
  const existingSet = new Set(e);
  for (const tok of r) if (!existingSet.has(tok)) return false;
  return true;
}

/**
 * Resolve the final scope list for an OAuthClient invocation given the
 * three mutually-exclusive CLI flags + the persisted scope array.
 *
 * @param {object} args
 * @param {string|string[]|undefined} args.scope         --scope: replace existing
 * @param {string|string[]|undefined} args.addScope      --add-scope: merge into existing
 * @param {string|string[]|undefined} args.removeScope   --remove-scope: remove from existing
 * @param {string[]|undefined}        args.existing      Persisted scope array (or DEFAULT_SCOPE fallback)
 *
 * @returns {{ scopes: string[], warnings: string[], errorCode?: string, errorMessage?: string }}
 *   scopes        — the array to pass into OAuthClient
 *   warnings      — stderr advisories (subset replace, no-op removals, etc.)
 *   errorCode     — set when mutual-exclusion violated; caller should throw CliError
 *   errorMessage  — human-readable message for the typed error
 */
function computeScopeMutation(args) {
  const { scope, addScope, removeScope, existing } = args;
  const set = (v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  const flags = [
    set(scope) ? '--scope' : null,
    set(addScope) ? '--add-scope' : null,
    set(removeScope) ? '--remove-scope' : null,
  ].filter(Boolean);

  if (flags.length > 1) {
    return {
      scopes: parseScopeList(existing),
      warnings: [],
      errorCode: 'reauth_scope_flag_conflict',
      errorMessage:
        `reauth: ${flags.join(', ')} are mutually exclusive — each flag does one job. ` +
        `Use --add-scope to merge new scopes into the existing set, --remove-scope to ` +
        `drop scopes by exact match, or --scope to replace the entire set.`,
    };
  }

  const existingArr = parseScopeList(existing);

  if (set(addScope)) {
    return { scopes: mergeScopes(existingArr, addScope), warnings: [] };
  }

  if (set(removeScope)) {
    const { result, missing } = removeScopes(existingArr, removeScope);
    const warnings = [];
    for (const m of missing) {
      warnings.push(`reauth: --remove-scope: "${m}" was not in the existing scope set (no-op).`);
    }
    return { scopes: result, warnings };
  }

  if (set(scope)) {
    const replacement = parseScopeList(scope);
    const warnings = [];
    if (existingArr.length > 0 && isStrictSubset(replacement, existingArr)) {
      const dropped = existingArr.filter((s) => !replacement.includes(s));
      warnings.push(
        `reauth: --scope replaces ${existingArr.length} existing scopes with ${replacement.length} new ones — ` +
        `this drops ${dropped.length} scope${dropped.length === 1 ? '' : 's'} (${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? ', ...' : ''}). ` +
        `Use --add-scope to merge instead.`
      );
    }
    return { scopes: replacement, warnings };
  }

  // No scope flag — fall back to existing (caller defaults to DEFAULT_SCOPE
  // when existing is empty / not present).
  return { scopes: existingArr, warnings: [] };
}

module.exports = {
  parseScopeList,
  mergeScopes,
  removeScopes,
  isStrictSubset,
  computeScopeMutation,
};
