'use strict';

/**
 * Shared REST error helpers for HTTP transports.
 *
 * Kept as a single small module so both HttpTransport and OAuthHttpTransport
 * use identical detection logic — no duplication, no drift between the two.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

/**
 * Returns true if an HTTP response body is a WordPress `rest_no_route` error.
 * This indicates the configured REST route does not exist on the server —
 * a structurally non-recoverable condition (Issue #103).
 *
 * Safe on any input: non-string, empty string, and non-JSON all return false.
 *
 * @param {*} body - Raw HTTP response body string
 * @returns {boolean}
 */
function isRestNoRoute(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  try { return JSON.parse(body).code === 'rest_no_route'; } catch { return false; }
}

module.exports = { isRestNoRoute };
