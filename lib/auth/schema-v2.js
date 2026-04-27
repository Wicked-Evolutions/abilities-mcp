'use strict';

const { AUTH_STATUS } = require('./events');

/**
 * wp-sites.json schema v2 — defined in design doc Appendix F.5 with
 * amendments from H.2.3 (oauth_capability_pinned).
 *
 * The bridge supports both `oauth` and `apppassword` per site. OAuth always
 * takes precedence; `apppassword_fallback` fires only when OAuth discovery
 * returns 404 (no pin) — silent fallback for reverse compatibility. A pinned
 * site that loses OAuth fails loud (H.2.3 — handled in discovery-client).
 *
 * This module ships a minimal validator. The bridge's existing config.js
 * does richer transport-specific validation; v2 adds:
 *   - schema_version === 2 sentinel
 *   - auth.method ∈ {'oauth','apppassword'} per site
 *   - auth_status ∈ {'active','expired','revoked','pending-reauth'}
 *   - oauth_capability_pinned shape (when present)
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const SCHEMA_VERSION = 2;
const AUTH_METHODS = Object.freeze(['oauth', 'apppassword']);
const VALID_AUTH_STATUS = Object.freeze(Object.values(AUTH_STATUS));

/**
 * @param {object} config  Parsed wp-sites.json
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
function validate(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['config is not an object'] };
  }
  if (config.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}, got ${JSON.stringify(config.schema_version)}`);
  }
  if (!config.sites || typeof config.sites !== 'object') {
    return { ok: false, errors: errors.concat(['sites object is missing']) };
  }
  for (const [siteId, site] of Object.entries(config.sites)) {
    const prefix = `sites.${siteId}`;
    if (!site || typeof site !== 'object') {
      errors.push(`${prefix} is not an object`);
      continue;
    }
    if (typeof site.url !== 'string' || site.url.length === 0) {
      errors.push(`${prefix}.url is missing`);
    }
    if (!site.auth || typeof site.auth !== 'object') {
      errors.push(`${prefix}.auth is missing`);
      continue;
    }
    if (!AUTH_METHODS.includes(site.auth.method)) {
      errors.push(`${prefix}.auth.method must be one of ${AUTH_METHODS.join(', ')}`);
    }
    if (site.auth_status && !VALID_AUTH_STATUS.includes(site.auth_status)) {
      errors.push(`${prefix}.auth_status must be one of ${VALID_AUTH_STATUS.join(', ')}`);
    }
    if (site.auth.method === 'oauth') {
      for (const k of ['client_id', 'access_token_ref', 'refresh_token_ref']) {
        if (typeof site.auth[k] !== 'string') {
          errors.push(`${prefix}.auth.${k} is required for OAuth sites`);
        }
      }
    } else if (site.auth.method === 'apppassword') {
      if (typeof site.auth.username !== 'string') {
        errors.push(`${prefix}.auth.username is required for App Password sites`);
      }
      if (typeof site.auth.password_ref !== 'string') {
        errors.push(`${prefix}.auth.password_ref is required for App Password sites`);
      }
    }
    if (site.oauth_capability_pinned) {
      const pin = site.oauth_capability_pinned;
      if (typeof pin !== 'object'
          || typeof pin.first_seen_at !== 'string'
          || typeof pin.last_confirmed_at !== 'string') {
        errors.push(`${prefix}.oauth_capability_pinned must be { first_seen_at, last_confirmed_at }`);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Build a minimal v2 config skeleton.
 * @param {object} [opts]
 * @param {string} [opts.defaultSite]
 * @returns {object}
 */
function emptyConfig(opts = {}) {
  return {
    $schema: 'https://wickedevolutions.com/schemas/abilities-mcp/wp-sites/v2.json',
    schema_version: SCHEMA_VERSION,
    defaultSite: opts.defaultSite,
    sites: {},
  };
}

module.exports = {
  SCHEMA_VERSION,
  AUTH_METHODS,
  VALID_AUTH_STATUS,
  validate,
  emptyConfig,
};
