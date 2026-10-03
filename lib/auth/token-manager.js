'use strict';

const { postForm } = require('./http-json');
const { resolveRef, parseRef, makeRef } = require('./secret-store');
const { CredentialCoordinator } = require('./credential-coordinator');
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
// A refresh attempt is replay-safe only for a bounded period. Keep every
// individual request below that period and persist the attempt before send.
const HTTP_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 1; // two sends total, bounded by the coordinator's 25s marker
const SECRET_SERVICE = 'abilities-mcp';
const MAX_DURATION_SECONDS = 253402300799;

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


function _malformedExpiry(message) {
  return new RefreshError(`Token endpoint returned malformed expiry metadata: ${message}`, {
    code: 'malformed_expiry_metadata', state: 'refreshing',
  });
}

function _positiveSeconds(value, field, required) {
  if (value === undefined && !required) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_DURATION_SECONDS) {
    throw _malformedExpiry(`${field} must be a positive finite integer seconds value`);
  }
  return value;
}

function _timestampFromSeconds(startMs, seconds, field) {
  const value = startMs + seconds * 1000;
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw _malformedExpiry(`${field} computes outside UTC years 0001–9999`);
  }
  return date.toISOString();
}

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
    this._coordinator = args.credentialCoordinator || null;
  }

  /**
   * Parse authoritative expiry fields without silently replacing malformed
   * server values with an old local duration. `refresh_expires_in` is a
   * transition alias only; the draft-aligned field wins when both occur.
   */
  _parseExpiryMetadata(tokens, requestStartMs) {
    const accessSeconds = _positiveSeconds(tokens && tokens.expires_in, 'expires_in', true);
    const refreshSeconds = Object.prototype.hasOwnProperty.call(tokens || {}, 'refresh_token_timeout')
      ? _positiveSeconds(tokens.refresh_token_timeout, 'refresh_token_timeout', false)
      : (Object.prototype.hasOwnProperty.call(tokens || {}, 'refresh_expires_in')
        ? _positiveSeconds(tokens.refresh_expires_in, 'refresh_expires_in', false)
        : null);
    const authorizationSeconds = Object.prototype.hasOwnProperty.call(tokens || {}, 'authorization_expires_in')
      ? _positiveSeconds(tokens.authorization_expires_in, 'authorization_expires_in', false)
      : null;
    const accessAt = _timestampFromSeconds(requestStartMs, accessSeconds, 'expires_in');
    const refreshAt = refreshSeconds === null
      ? null
      : _timestampFromSeconds(requestStartMs, refreshSeconds, 'refresh_token_timeout');
    const authorizationAt = authorizationSeconds === null
      ? null
      : _timestampFromSeconds(requestStartMs, authorizationSeconds, 'authorization_expires_in');
    if (authorizationAt && Date.parse(accessAt) > Date.parse(authorizationAt)) {
      throw _malformedExpiry('authorization_expires_in must cap expires_in');
    }
    if (authorizationAt && refreshAt && Date.parse(refreshAt) > Date.parse(authorizationAt)) {
      throw _malformedExpiry('authorization_expires_in must cap refresh_token_timeout');
    }
    const accessRemaining = accessSeconds;
    const refreshRemaining = refreshSeconds;
    const L = refreshRemaining === null ? accessRemaining : Math.min(accessRemaining, refreshRemaining);
    const lead = Math.min(300, Math.max(1, Math.floor(L / 10)), Math.max(0, L - 1));
    return {
      accessTokenExpiresAt: accessAt,
      refreshTokenExpiresAt: refreshAt,
      authorizationExpiresAt: authorizationAt,
      nextRefreshAt: new Date(requestStartMs + (L - lead) * 1000).toISOString(),
      refreshTimeoutProvided: refreshSeconds !== null,
      expirySource: Object.prototype.hasOwnProperty.call(tokens || {}, 'refresh_token_timeout')
        ? 'authoritative' : (refreshSeconds === null ? 'not-provided' : 'legacy-alias'),
    };
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
    const currentAuth = await this._hydratePair(siteAuth);
    const needsRefresh = opts.forceRefresh || this._isWithinRefreshWindow(currentAuth);
    if (!needsRefresh) {
      const accessToken = currentAuth._accessToken || await resolveRef(this._store, currentAuth.accessTokenRef);
      const adopted = currentAuth.credentialGeneration !== siteAuth.credentialGeneration ||
        currentAuth.clientId !== siteAuth.clientId || currentAuth.mcpResource !== siteAuth.mcpResource;
      return { accessToken, refreshed: false, updatedAuth: adopted ? currentAuth : undefined };
    }
    const refreshed = await this.refresh(currentAuth);
    return {
      accessToken: refreshed.tokens.access_token,
      refreshed: true,
      updatedAuth: refreshed.updatedAuth,
      tokens: refreshed.tokens,
    };
  }

  async _hydratePair(siteAuth) {
    if (this._coordinator && this._coordinator.hasConfig) {
      return this._coordinator.readValidatedSnapshot(siteAuth);
    }
    if (!this._coordinator || !siteAuth || !siteAuth.credentialPairRef) return siteAuth;
    const pair = await this._coordinator.readPair({
      credential_pair_ref: siteAuth.credentialPairRef,
      credential_generation: siteAuth.credentialGeneration,
    });
    return { ...siteAuth, _accessToken: pair.access_token, _refreshToken: pair.refresh_token };
  }

  /**
   * Returns true if the access token will expire within REFRESH_WINDOW_SECONDS.
   * @param {SiteAuthState} siteAuth
   */
  _isWithinRefreshWindow(siteAuth) {
    if (siteAuth.nextRefreshAt) {
      const nextRefreshAt = Date.parse(siteAuth.nextRefreshAt);
      if (!Number.isNaN(nextRefreshAt)) {
        if (this._now() < nextRefreshAt) return false;
        const accessAt = Date.parse(siteAuth.accessTokenExpiresAt);
        const deadlineAt = Date.parse(siteAuth.authorizationExpiresAt);
        // A refresh cannot extend access past a fixed deadline. Keep the
        // already usable token instead of rotating through the final lead.
        if (!Number.isNaN(accessAt) && !Number.isNaN(deadlineAt) && accessAt >= deadlineAt && this._now() < accessAt) return false;
        return true;
      }
    }
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
    const currentAuth = await this._hydratePair(siteAuth);
    const identity = this._coordinator && CredentialCoordinator.identityForAuth(currentAuth);
    if (this._coordinator && identity) {
      return this._coordinator.withCredentialLock(
        identity,
        'refresh',
        () => this._refreshUnlocked(currentAuth)
      );
    }
    return this._refreshUnlocked(currentAuth);
  }

  async _refreshUnlocked(siteAuth) {
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

    if (!siteAuth.refreshTokenRef && !siteAuth._refreshToken) {
      throw new RefreshError('No refresh token configured for site', {
        code: 'no_refresh_token', state: 'refreshing',
      });
    }
    const refreshToken = siteAuth._refreshToken || await resolveRef(this._store, siteAuth.refreshTokenRef);
    // Expiry timestamps use request start, never a delayed response receipt,
    // so a slow network response cannot extend locally displayed authority.
    const requestStartMs = this._now();
    // A legacy fixed-reference site is migrated only through this durable
    // path. A pair site also uses it for every rotation. The marker survives
    // a lost response and prevents stale processes from publishing late.
    let marker = null;
    if (this._coordinator && this._coordinator.hasConfig) {
      const recovered = await this._coordinator.recoverPrepared(siteAuth);
      if (recovered && !recovered.retry) {
        const auth = { ...siteAuth, ...recovered };
        const pair = await this._coordinator.readPair({
          credential_pair_ref: auth.credentialPairRef,
          credential_generation: auth.credentialGeneration,
        });
        return { tokens: { access_token: pair.access_token, refresh_token: pair.refresh_token }, updatedAuth: auth };
      }
      marker = recovered && recovered.marker || await this._coordinator.beginRefresh(siteAuth);
    }

    let res;
    let attempt = 0;
    let lastNetworkError = null;
    /* eslint-disable no-constant-condition */
    while (true) {
      try {
        if (marker) await this._coordinator.recordRefreshAttempt(marker);
        const remainingMs = marker ? Date.parse(marker.recovery_deadline_at) - this._now() : HTTP_TIMEOUT_MS;
        if (remainingMs <= 0) throw new RefreshError('OAuth refresh outcome is unknown; run reauth', {
          code: 'unknown_refresh_outcome', state: 'refreshing',
        });
        res = await this._postForm(siteAuth.tokenEndpoint, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: siteAuth.clientId,
        }, { timeoutMs: Math.min(HTTP_TIMEOUT_MS, remainingMs), allowInsecure: this._allowInsecure });
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

    // Success — validate before doing any protected write. A Mycelium
    // profile response that rotates/returns a refresh token must carry its
    // authoritative refresh timeout; legacy responses remain explicitly
    // unknown rather than being silently given a local ninety-day value.
    const tokens = res.json;
    const expiry = this._parseExpiryMetadata(tokens, requestStartMs);
    if (this._coordinator && marker) {
      const committed = await this._coordinator.commitRefresh(marker, siteAuth, tokens, expiry);
      return {
        tokens,
        updatedAuth: { ...siteAuth, ...committed, authStatus: AUTH_STATUS.ACTIVE },
      };
    }

    // Compatibility path for callers without a config-backed coordinator
    // (not the runtime). Pair storage still avoids splitting a rotation.
    if (this._coordinator && siteAuth.credentialPairRef) {
      const prepared = await this._coordinator.preparePair({
        auth: {
          credential_identity: siteAuth.credentialIdentity,
          credential_pair_slot: siteAuth.credentialPairSlot,
        },
        tokens: {
          access_token: tokens.access_token,
          refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : refreshToken,
        },
        accessTokenExpiresAt: expiry.accessTokenExpiresAt,
        refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
        authorizationExpiresAt: expiry.authorizationExpiresAt,
        nextRefreshAt: expiry.nextRefreshAt,
      });
      return {
        tokens,
        updatedAuth: {
          ...siteAuth,
          ...prepared,
          accessTokenExpiresAt: expiry.accessTokenExpiresAt,
          refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
          authorizationExpiresAt: expiry.authorizationExpiresAt,
          nextRefreshAt: expiry.nextRefreshAt,
          refreshExpirySource: expiry.expirySource,
          authStatus: AUTH_STATUS.ACTIVE,
        },
      };
    }

    // Legacy direct callers retain their existing refs. Production runtime
    // has a config-backed coordinator and therefore never uses this branch.
    const accessAccount = parseRef(siteAuth.accessTokenRef).account;
    await this._store.set(SECRET_SERVICE, accessAccount, tokens.access_token);

    let refreshAccount = parseRef(siteAuth.refreshTokenRef).account;
    let refreshTokenRef = siteAuth.refreshTokenRef;
    if (typeof tokens.refresh_token === 'string' && tokens.refresh_token !== refreshToken) {
      // Rotation — write the new refresh token under the same account.
      await this._store.set(SECRET_SERVICE, refreshAccount, tokens.refresh_token);
      refreshTokenRef = makeRef(SECRET_SERVICE, refreshAccount);
    }

    const updatedAuth = {
      ...siteAuth,
      accessTokenRef: makeRef(SECRET_SERVICE, accessAccount),
      refreshTokenRef,
      accessTokenExpiresAt: expiry.accessTokenExpiresAt,
      // Missing timeout metadata is deliberately unknown/not-provided. Keep
      // a legacy stored value only as a compatibility guard, never as a new
      // locally invented rolling duration.
      refreshTokenExpiresAt: expiry.refreshTokenExpiresAt || siteAuth.refreshTokenExpiresAt,
      authorizationExpiresAt: expiry.authorizationExpiresAt,
      nextRefreshAt: expiry.nextRefreshAt,
      refreshExpirySource: expiry.expirySource,
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

    const expiry = this._parseExpiryMetadata(tokens, this._now());
    if (this._coordinator) {
      if (typeof tokens.refresh_token !== 'string') {
        throw new Error('OAuth authorization response is missing refresh_token');
      }
      const prepared = await this._coordinator.preparePair({
        credentialIdentity: args.credentialIdentity || CredentialCoordinator.newIdentity(),
        auth: { credential_pair_slot: 'b' },
        tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
        accessTokenExpiresAt: expiry.accessTokenExpiresAt,
        refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
        authorizationExpiresAt: expiry.authorizationExpiresAt,
        nextRefreshAt: expiry.nextRefreshAt,
      });
      return {
        credentialPairRef: prepared.credential_pair_ref,
        credentialGeneration: prepared.credential_generation,
        credentialIdentity: prepared.credential_identity,
        credentialPairSlot: prepared.credential_pair_slot,
        accessTokenExpiresAt: expiry.accessTokenExpiresAt,
        refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
        authorizationExpiresAt: expiry.authorizationExpiresAt,
        nextRefreshAt: expiry.nextRefreshAt,
        refreshExpirySource: expiry.expirySource,
      };
    }

    const accessAccount = `${siteId}/access`;
    const refreshAccount = `${siteId}/refresh`;
    await this._store.set(SECRET_SERVICE, accessAccount, tokens.access_token);

    let refreshTokenRef = null;
    if (typeof tokens.refresh_token === 'string') {
      await this._store.set(SECRET_SERVICE, refreshAccount, tokens.refresh_token);
      refreshTokenRef = makeRef(SECRET_SERVICE, refreshAccount);
    }

    return {
      accessTokenRef: makeRef(SECRET_SERVICE, accessAccount),
      refreshTokenRef,
      accessTokenExpiresAt: expiry.accessTokenExpiresAt,
      refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
      authorizationExpiresAt: expiry.authorizationExpiresAt,
      nextRefreshAt: expiry.nextRefreshAt,
      refreshExpirySource: expiry.expirySource,
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
