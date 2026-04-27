'use strict';

/**
 * Minimal CLI arg parser for the abilities-mcp subcommand surface.
 *
 * Supported forms:
 *   <subcommand> <positional...> [--flag] [--key=value] [--key value]
 *
 * Boolean flags: `--debug`, `--apppassword`, `--confirm`, `--force`,
 * `--allow-insecure`, `--i-understand-the-risk`.
 *
 * Value flags accept either `--key=value` or `--key value` form.
 *
 * Long options only — no short forms — to keep the surface small and
 * predictable. The argv array starts at the subcommand (i.e. caller has
 * already sliced argv to remove `node` / script path).
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

// Keys we treat as boolean even when they appear as `--key value` — value
// will be left as a positional. (Currently empty; we use the "next token
// is a flag → boolean" heuristic, which works for our flags.)
const BOOLEAN_FLAGS = new Set([
  'debug',
  'apppassword',
  'confirm',
  'force',
  'allow-insecure',
  'i-understand-the-risk',
]);

/**
 * @param {string[]} argv  Tokens after the subcommand name.
 * @returns {object}        { _: [...positionals], <flag>: <value|true>, ... }
 */
function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      // Everything after `--` is positional.
      for (let j = i + 1; j < argv.length; j++) out._.push(argv[j]);
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > -1) {
        const key = tok.slice(2, eq);
        const value = tok.slice(eq + 1);
        out[key] = _coerce(value);
        continue;
      }
      const key = tok.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        out[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
        continue;
      }
      out[key] = _coerce(next);
      i++;
    } else {
      out._.push(tok);
    }
  }
  return out;
}

function _coerce(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

module.exports = { parse, BOOLEAN_FLAGS };
