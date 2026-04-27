'use strict';

const { postForm } = require('./http-json');
const { resolveRef, parseRef, makeRef } = require('./secret-store');
const { RefreshError, AuthError } = require('./errors');
const { AUTH_STATUS } = require('./events');

/**
 * TokenManager — runs the bridge's pre-call refresh + retry policy and the
 * OAuth-capability pin bookkeeping.
 *
 * Binding rules (Appendix H.2.1):
 *   - HTTP timeout: 30s read/write.
 *   - Retry policy: on network error or 5xx, retry up to 2 times with the
 *     SAME refresh token. The adapter's 30s grace window honors this.
 *   - NEVER retry on 4xx — the server has decided.
 *   - Persist intent-to-refresh to keychain BEFORE sending the request. Mark
 *     refresh complete only after 200 received and new tokens persisted. On
 *     crash mid-flight, the old refresh token is still in keychain; the next
 *     call retries with it.
 *
 * Refresh window:
 *   - Refresh when access_token_expires_at is within 300 seconds (Appendix
 *     "Token refresh" + H.4.5 clock-skew row).
 *
 * On auth failure (4xx from /oauth/token):
 *   - Set auth_status to "expired".
 *   - Surface a reauth hint via the returned Result object (callers wire
 *     this into CLI / GUI messaging — no console output here).
 *   - Other sites are unaffected.
 *
 * Capability pinning (Appendix H.2.3):
 *   - On every successful discovery, callers should refresh
 *     `oauth_capability_pinned.last_confirmed_at`.
 *   - On 404 against a pinned site, throw CapabilityPinningError (handled
 *     by discovery-client); this module exposes helpers to update the pin.
 *
 * The TokenManager does not perform discovery — discovery happens during
 * add-site / reauth (oauth-client.js). The TokenManager only refreshes
 * tokens against an already-known token endpoint.
 *
 * @typedef {object} TokenSet
 * @property {string} access_token
 * @property {string} refresh_token
 * @property {number} expires_in                seconds
 * @property {string} [token_type]
 * @property {string} [scope]
 *
 * @typedef {object} SiteAuthState
 * @property {string} siteId
 * @property {string} tokenEndpoint
 * @property {string} clientId
 * @property {string} accessTokenRef            keychain://...
 * @property {string} refreshTokenRef           keychain://...
 * @property {string} accessTokenExpiresAt      ISO 8601
 * @property {string} refreshTokenExpiresAt     ISO 8601
 * @property {string} authStatus                'active' | 'expired' | 'revoked' | 'pending-reauth'
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const REFRESH_WINDOW_SECONDS = 300;
const HTTP_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const SECRET_SERVICE = 'abilities-mcp';

class TokenManager {
  /**
   * @param {object} args
   * @param {object} args.secretStore                 SecretStore instance
   * @param {object} [args.deps]
   * @param {Function} [args.deps.postForm]
   * @param {(ms:number)=>Promise<void>} [args.deps.sleep]
   * @param {()=>number} [args.deps.now]              Defaults to Date.now
   */
  constructor(args) {
    if (!args || !args.secretStore) {
      throw new Error('TokenManager requires secretStore');
    }
    this._store = args.secretStore;
    this._allowInsecure = !!args.allowInsecure;
    const deps = args.deps || {};
    this._postForm = deps.postForm || postForm;
    this._sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._now = deps.now || (() => Date.now());
  }

  // ---------------------------------------------------------------------
  // Bearer token resolution
  // ---------------------------------------------------------------------

  /**
   * Returns a usable access token for `siteAuth`, refreshing if within the
   * refresh window or if explicitly forced.
   *
   * @param {SiteAuthState} siteAuth
   * @param {object} [opts]
   * @param {boolean} [opts.forceRefresh]
   * @returns {Promise<{accessToken:string, refreshed:boolean, updatedAuth?:SiteAuthState, tokens?:TokenSet}>}
   */
  async getAccessToken(siteAuth, opts = {}) {
    const needsRefresh = opts.forceRefresh || this._isWithinRefreshWindow(siteAuth);
    if (!needsRefresh) {
      const accessToken = await resolveRef(this._store, siteAuth.accessTokenRef);
      return { accessToken, refreshed: false };
    }
    const refreshed = await this.refresh(siteAuth);
    return {
      accessToken: refreshed.tokens.access_token,
      refreshed: true,
      updatedAuth: refreshed.updatedAuth,
      tokens: refreshed.tokens,
    };
  }

  /**
   * Returns true if the access token will expire within REFRESH_WINDOW_SECONDS.
   * @param {SiteAuthState} siteAuth
   */
  _isWithinRefreshWindow(siteAuth) {
    if (!siteAuth.accessTokenExpiresAt) return true;
    const expiresAt = Date.parse(siteAuth.accessTokenExpiresAt);
    if (Number.isNaN(expiresAt)) return true;
    const msUntilExpiry = expiresAt - this._now();
    return msUntilExpiry <= REFRESH_WINDOW_SECONDS * 1000;
  }

  // ---------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------

  /**
   * Refresh the access token. Handles H.2.1 retry semantics.
   *
   * @param {SiteAuthState} siteAuth
   * @returns {Promise<{tokens: TokenSet, updatedAuth: SiteAuthState}>}
   */
  async refresh(siteAuth) {
    if (siteAuth.authStatus === AUTH_STATUS.EXPIRED) {
      throw new RefreshError(
        `Refresh token expired for site "${siteAuth.siteId}". ` +
        `Run: abilities-mcp reauth ${siteAuth.siteId}`,
        { code: 'reauth_required', state: 'refreshing' }
      );
    }
    if (siteAuth.authStatus === AUTH_STATUS.REVOKED) {
      throw new RefreshError(
        `Refresh token revoked for site "${siteAuth.siteId}".`,
        { code: 'revoked', state: 'refreshing' }
      );
    }

    if (!siteAuth.refreshTokenRef) {
      throw new RefreshError('No refresh token configured for site', {
        code: 'no_refresh_token', state: 'refreshing',
      });
    }
    const refreshToken = await resolveRef(this._store, siteAuth.refreshTokenRef);

    // Persist intent-to-refresh BEFORE sending — see H.2.1 paragraph
    // "Persist intent-to-refresh to keychain BEFORE sending the request".
    // We mark the in-flight state as a small marker entry; the actual
    // refresh-token value is unchanged in keychain so a crash leaves the
    // old token recoverable.
    const intentAccount = `${siteAuth.siteId}/refresh-intent`;
    await this._store.set(SECRET_SERVICE, intentAccount, JSON.stringify({
      startedAt: new Date(this._now()).toISOString(),
      tokenEndpoint: siteAuth.tokenEndpoint,
    }));

    let res;
    let attempt = 0;
    let lastNetworkError = null;
    /* eslint-disable no-constant-condition */
    while (true) {
      try {
        res = await this._postForm(siteAuth.tokenEndpoint, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: siteAuth.clientId,
        }, { timeoutMs: HTTP_TIMEOUT_MS, allowInsecure: this._allowInsecure });
      } catch (err) {
        // Network error path.
        lastNetworkError = err;
        if (attempt < MAX_RETRIES) {
          attempt++;
          await this._sleep(this._backoffMs(attempt));
          continue;
        }
        await this._store.delete(SECRET_SERVICE, intentAccount).catch(() => {});
        throw new RefreshError(
          `Refresh failed after ${MAX_RETRIES + 1} network-error attempts: ${err.message}`,
          { code: 'network_error', state: 'refreshing', cause: err }
        );
      }
      // 5xx → retry with same refresh token.
      if (res.statusCode >= 500 && res.statusCode <= 599) {
        if (attempt < MAX_RETRIES) {
          attempt++;
          await this._sleep(this._backoffMs(attempt));
          continue;
        }
        await this._store.delete(SECRET_SERVICE, intentAccount).catch(() => {});
        throw new RefreshError(
          `Refresh failed after ${MAX_RETRIES + 1} attempts (last status ${res.statusCode})`,
          { code: 'server_error', state: 'refreshing', cause: { statusCode: res.statusCode, body: res.body } }
        );
      }
      // 4xx → never retry.
      if (res.statusCode >= 400 && res.statusCode <= 499) {
        await this._store.delete(SECRET_SERVICE, intentAccount).catch(() => {});
        const oauthError = res.json && res.json.error ? res.json.error : 'invalid_grant';
        const description = res.json && res.json.error_description;
        // Mark the site as expired so the caller can route the operator to reauth.
        const updatedAuth = { ...siteAuth, authStatus: AUTH_STATUS.EXPIRED };
        const err = new RefreshError(
          `Refresh rejected (${oauthError}${description ? ': ' + description : ''}). ` +
          `Run: abilities-mcp reauth ${siteAuth.siteId}`,
          {
            code: oauthError,
            state: 'refreshing',
            cause: { statusCode: res.statusCode, body: res.body },
          }
        );
        err.updatedAuth = updatedAuth;
        err.reauthHint = { siteId: siteAuth.siteId, command: `abilities-mcp reauth ${siteAuth.siteId}` };
        throw err;
      }
      // 2xx
      break;
    }

    if (!res.json || typeof res.json.access_token !== 'string') {
      await this._store.delete(SECRET_SERVICE, intentAccount).catch(() => {});
      throw new RefreshError('Token endpoint returned 2xx without access_token', {
        code: 'malformed_response', state: 'refreshing',
        cause: { body: res.body },
      });
    }

    // Success — persist new tokens, then clear the intent marker.
    const tokens = res.json;
    const accessAccount = parseRef(siteAuth.accessTokenRef).account;
    await this._store.set(SECRET_SERVICE, accessAccount, tokens.access_token);

    let refreshAccount = parseRef(siteAuth.refreshTokenRef).account;
    let refreshTokenRef = siteAuth.refreshTokenRef;
    if (typeof tokens.refresh_token === 'string' && tokens.refresh_token !== refreshToken) {
      // Rotation — write the new refresh token under the same account.
      await this._store.set(SECRET_SERVICE, refreshAccount, tokens.refresh_token);
      refreshTokenRef = makeRef(SECRET_SERVICE, refreshAccount);
    }

    await this._store.delete(SECRET_SERVICE, intentAccount).catch(() => {});

    const expiresInSec = typeof tokens.expires_in === 'number' ? tokens.expires_in : null;
    const updatedAuth = {
      ...siteAuth,
      accessTokenRef: makeRef(SECRET_SERVICE, accessAccount),
      refreshTokenRef,
      accessTokenExpiresAt: expiresInSec
        ? new Date(this._now() + expiresInSec * 1000).toISOString()
        : siteAuth.accessTokenExpiresAt,
      authStatus: AUTH_STATUS.ACTIVE,
    };

    return { tokens, updatedAuth };
  }

  _backoffMs(attempt) {
    // Modest backoff so the second retry stays inside the adapter's 30s
    // grace window (H.2.1). 500ms then 1500ms.
    return attempt === 1 ? 500 : 1500;
  }

  // ---------------------------------------------------------------------
  // Persist new token set (used after add-site / reauth completes)
  // ---------------------------------------------------------------------

  /**
   * Store a freshly-issued token set in the secret store and return refs +
   * computed expiry timestamps suitable for writing into wp-sites.json v2.
   *
   * @param {object} args
   * @param {string} args.siteId
   * @param {TokenSet} args.tokens
   * @returns {Promise<{
   *   accessTokenRef:string, refreshTokenRef:string,
   *   accessTokenExpiresAt:string, refreshTokenExpiresAt:string,
   * }>}
   */
  async persistTokens(args) {
    if (!args || !args.siteId || !args.tokens) {
      throw new Error('persistTokens requires { siteId, tokens }');
    }
    const { siteId, tokens } = args;
    if (typeof tokens.access_token !== 'string') {
      throw new Error('tokens.access_token is required');
    }

    const accessAccount = `${siteId}/access`;
    const refreshAccount = `${siteId}/refresh`;
    await this._store.set(SECRET_SERVICE, accessAccount, tokens.access_token);

    let refreshTokenRef = null;
    if (typeof tokens.refresh_token === 'string') {
      await this._store.set(SECRET_SERVICE, refreshAccount, tokens.refresh_token);
      refreshTokenRef = makeRef(SECRET_SERVICE, refreshAccount);
    }

    const nowMs = this._now();
    const accessSec = typeof tokens.expires_in === 'number' ? tokens.expires_in : 24 * 3600;
    // Refresh expiry is not part of the standard token response. Fall back to
    // 90 days (the adapter's default per design doc decision #5).
    const refreshSec = typeof tokens.refresh_expires_in === 'number'
      ? tokens.refresh_expires_in
      : 90 * 24 * 3600;

    return {
      accessTokenRef: makeRef(SECRET_SERVICE, accessAccount),
      refreshTokenRef,
      accessTokenExpiresAt: new Date(nowMs + accessSec * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(nowMs + refreshSec * 1000).toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // Capability pinning helpers (H.2.3)
  // ---------------------------------------------------------------------

  /**
   * Build the pin object to write under `oauth_capability_pinned`.
   * @param {object} [existing]                Existing pin (for refresh)
   * @returns {{firstSeenAt:string, lastConfirmedAt:string}}
   */
  buildPin(existing) {
    const now = new Date(this._now()).toISOString();
    if (existing && existing.firstSeenAt) {
      return { firstSeenAt: existing.firstSeenAt, lastConfirmedAt: now };
    }
    return { firstSeenAt: now, lastConfirmedAt: now };
  }

  // ---------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------

  /**
   * Server-side revocation (RFC 7009) of a token. Network/5xx errors raise.
   * 4xx other than `unsupported_token_type` are treated as success — the
   * server has a final say.
   * @param {object} args
   * @param {string} args.revocationEndpoint
   * @param {string} args.token
   * @param {string} args.clientId
   * @param {string} [args.tokenTypeHint]
   */
  async revoke(args) {
    if (!args || !args.revocationEndpoint) {
      throw new AuthError('revoke requires revocationEndpoint', { code: 'missing_endpoint' });
    }
    const params = {
      token: args.token,
      client_id: args.clientId,
    };
    if (args.tokenTypeHint) params.token_type_hint = args.tokenTypeHint;
    const res = await this._postForm(args.revocationEndpoint, params, {
      timeoutMs: HTTP_TIMEOUT_MS,
      allowInsecure: this._allowInsecure,
    });
    if (res.statusCode >= 500) {
      throw new AuthError(`Revocation failed with ${res.statusCode}`, {
        code: 'revocation_failed',
        cause: { statusCode: res.statusCode, body: res.body },
      });
    }
    return { statusCode: res.statusCode };
  }
}

module.exports = {
  TokenManager,
  REFRESH_WINDOW_SECONDS,
  HTTP_TIMEOUT_MS,
  MAX_RETRIES,
  SECRET_SERVICE,
};
