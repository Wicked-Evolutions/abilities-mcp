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
 * @property {boolean} [slidingRenewal]         Issue #90: opt-in. When true,
 *                                              a successful refresh advances
 *                                              refreshTokenExpiresAt to mirror
 *                                              the adapter's re-issued TTL
 *                                              (sliding window). Absent/false
 *                                              = default bounded behavior.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const REFRESH_WINDOW_SECONDS = 300;
const HTTP_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const SECRET_SERVICE = 'abilities-mcp';

// Issue #89: OAuth token-endpoint `error` codes that are STRONG terminal
// evidence — the grant is really gone, reauth is genuinely required. A bare
// `invalid_grant` is intentionally NOT here: it can occur on a transient
// server-state hiccup, and treating it as terminal while the refresh token is
// still valid for months is exactly the sticky-expired trap (#76/#89). Such a
// transient is gated by actual on-disk refresh-token expiry instead.
const TERMINAL_OAUTH_ERRORS = new Set([
  'invalid_client',
  'unauthorized_client',
  'revoked',
]);

// Issue #90 (opt-in sliding renewal): explicit ADAPTER-CONTRACT MIRROR, not a
// bare bridge constant. The adapter (abilities-mcp-adapter,
// src/Auth/OAuth/TokenStore.php) defines `REFRESH_TTL = 7776000` (90d) and
// re-issues a brand-new refresh token with a fresh REFRESH_TTL on EVERY
// `refresh_token` grant (TokenStore::rotate() → issue(... REFRESH_TTL ...)).
// So while a site is actively used the server-side credential already slides;
// the bridge just needs to persist that slid expiry instead of the frozen
// issuance value — but ONLY when the operator opts in per-site.
//
// The adapter does not yet emit `refresh_expires_in` in the token response, so
// the bridge cannot read the server's effective TTL and mirrors the constant
// here. Tracked as a split, non-blocking follow-up:
//   https://github.com/Wicked-Evolutions/abilities-mcp-adapter/issues/120
// Keep this value in sync with the adapter's TokenStore::REFRESH_TTL until
// that follow-up lands and the bridge can compute the slide from the response.
const ADAPTER_REFRESH_TTL_SECONDS = 90 * 24 * 3600; // mirror: TokenStore::REFRESH_TTL (7776000)

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

  /**
   * Issue #89: is the refresh token genuinely past its on-disk expiry (or has
   * no usable expiry recorded)? This is the trust signal for deciding whether
   * a cached `authStatus === "expired"` enum is believable, and whether a 4xx
   * from the token endpoint is strong terminal evidence.
   *
   * A missing or unparseable `refreshTokenExpiresAt` is treated as expired
   * (conservative — preserves the genuine-expiry terminal path when the field
   * is absent; never makes a stuck site stickier than before).
   *
   * @param {SiteAuthState} siteAuth
   * @returns {boolean} true when the refresh token is past/has-no expiry.
   */
  _refreshTokenActuallyExpired(siteAuth) {
    const raw = siteAuth && siteAuth.refreshTokenExpiresAt;
    if (!raw) return true;
    const expiresAt = Date.parse(raw);
    if (Number.isNaN(expiresAt)) return true;
    return expiresAt <= this._now();
  }

  // ---------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------

  /**
   * Refresh the access token.
   *
   * Retry semantics now live entirely on the server (adapter v1.4.2 ships
   * encrypt-at-rest grace-window retry per Wicked-Evolutions/abilities-mcp-adapter#61).
   * A retry within 30 seconds of a successful rotation returns the original
   * plaintext pair from a server-stored encrypted blob — the bridge does not
   * need a mid-flight crash-recovery marker. We just retry on transport
   * failures and 5xx; the server is idempotent within the grace window.
   *
   * @param {SiteAuthState} siteAuth
   * @returns {Promise<{tokens: TokenSet, updatedAuth: SiteAuthState}>}
   */
  async refresh(siteAuth) {
    // Issue #76/#89: do NOT trust a cached `authStatus === "expired"` enum on
    // its own. A single transient 4xx can have flipped it on disk while the
    // refresh token is still valid for months; short-circuiting here is what
    // made the state sticky (only manual reauth recovered). Consult the
    // on-disk `refreshTokenExpiresAt`: only short-circuit when the refresh
    // token is genuinely past/missing expiry. Otherwise fall through and let
    // the token endpoint be the authority — it returns a real 4xx if the
    // token is actually dead (the genuine-expiry terminal path, preserved).
    if (siteAuth.authStatus === AUTH_STATUS.EXPIRED &&
        this._refreshTokenActuallyExpired(siteAuth)) {
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
        throw new RefreshError(
          `Refresh failed after ${MAX_RETRIES + 1} attempts (last status ${res.statusCode})`,
          { code: 'server_error', state: 'refreshing', cause: { statusCode: res.statusCode, body: res.body } }
        );
      }
      // 4xx → never retry the HTTP call. But Issue #89: gate the *terminal*
      // `authStatus="expired"` persist on STRONG evidence (minimal gate,
      // B-orchestrator-approved option a):
      //   - an explicitly-terminal OAuth error (invalid_client /
      //     unauthorized_client / revoked), OR
      //   - the on-disk refresh_token_expires_at is genuinely past/missing.
      // A lone transient `invalid_grant` while the refresh token is still
      // valid for months must NOT flip the sticky flag — that evidence-free
      // write is what armed the #76/#89 trap. In that case surface a
      // retryable error and leave `auth_status` untouched so the next use /
      // boot re-attempts against the token endpoint.
      if (res.statusCode >= 400 && res.statusCode <= 499) {
        const oauthError = res.json && res.json.error ? res.json.error : 'invalid_grant';
        const description = res.json && res.json.error_description;
        const terminal =
          TERMINAL_OAUTH_ERRORS.has(oauthError) ||
          this._refreshTokenActuallyExpired(siteAuth);

        const err = new RefreshError(
          `Refresh rejected (${oauthError}${description ? ': ' + description : ''}).` +
          (terminal
            ? ` Run: abilities-mcp reauth ${siteAuth.siteId}`
            : ' Transient server-state — refresh token still valid; will retry on next use.'),
          {
            code: oauthError,
            state: 'refreshing',
            cause: { statusCode: res.statusCode, body: res.body },
          }
        );
        if (terminal) {
          // Strong evidence — route the operator to reauth and persist the
          // terminal state (the genuine-expiry path, preserved).
          err.updatedAuth = { ...siteAuth, authStatus: AUTH_STATUS.EXPIRED };
          err.reauthHint = { siteId: siteAuth.siteId, command: `abilities-mcp reauth ${siteAuth.siteId}` };
        } else {
          // Transient — do NOT attach updatedAuth (the wp-sites.json persist
          // trigger). Mark retryable so callers/logs can distinguish it.
          err.retryable = true;
        }
        throw err;
      }
      // 2xx
      break;
    }

    if (!res.json || typeof res.json.access_token !== 'string') {
      throw new RefreshError('Token endpoint returned 2xx without access_token', {
        code: 'malformed_response', state: 'refreshing',
        cause: { body: res.body },
      });
    }

    // Success — persist new tokens.
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

    // Issue #90: opt-in silent sliding renewal. Default (flag absent/false):
    // `refreshTokenExpiresAt` is carried unchanged from `...siteAuth` above —
    // byte-identical to today's bounded ~90-days-from-initial-auth behavior,
    // and `slidingRenewal` is left on updatedAuth so the persistence layer
    // can tell this rotation must NOT open a new write path. When the
    // operator has enabled it for this site, advance the on-disk refresh-token
    // expiry to mirror the fresh TTL the adapter just re-issued on rotation,
    // so an actively-used site renews indefinitely (it still lapses if left
    // untouched past the window — the next refresh hits the #89 expiry path).
    if (siteAuth.slidingRenewal === true) {
      updatedAuth.refreshTokenExpiresAt =
        new Date(this._now() + ADAPTER_REFRESH_TTL_SECONDS * 1000).toISOString();
    }

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
