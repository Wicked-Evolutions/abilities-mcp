'use strict';

const { EventEmitter } = require('node:events');

const { STATES, TERMINAL_STATES, EVENTS } = require('./events');
const { discover } = require('./discovery-client');
const { register } = require('./dcr-client');
const { LoopbackServer } = require('./loopback-server');
const { openBrowser } = require('./browser-launcher');
const { generatePkce, generateState } = require('./pkce');
const { postForm } = require('./http-json');
const {
  AuthError,
  TokenExchangeError,
} = require('./errors');

/**
 * OAuthClient — event-emitting state machine for the authorization-code +
 * PKCE flow. Defined in the design doc's "Architectural constraint: ship
 * CLI, architect for console" section as binding for v1.0.
 *
 * States (binding):
 *   idle → discovering → registering → awaiting_consent → exchanging
 *        → complete | failed
 *
 * Events emitted (see lib/auth/events.js):
 *   'state'       every transition, payload `{ from, to, data }`
 *   'progress'    sub-step info (e.g. discovery probe results)
 *   'complete'    terminal success
 *   'failed'      terminal failure
 *   plus one event per state name for observers that prefer named handlers.
 *
 * Public API:
 *   const client = new OAuthClient({ siteUrl, identityProvider, scope, ... });
 *   client.on('state', ({ from, to, data }) => { ... });
 *   const result = await client.run();
 *   // result = { tokens, scopes, clientId, asMetadata, prMetadata, capabilityPin }
 *
 * Constraints (from issue #12 and the sprint plan):
 *   - No console.* / process.* writes anywhere in this module.
 *   - Public methods map 1:1 to future CLI subcommands.
 *   - The state machine is the entire flow — no one-shot helpers that bypass
 *     it for "convenience."
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

// `abilities:multisite:read` / `abilities:multisite:write` are SENSITIVE_SCOPES
// in the adapter's ScopeRegistry (Auth/OAuth/ScopeRegistry.php) — never implied
// by the `abilities:read` / `abilities:write` umbrella expansion. Requesting
// them explicitly during DCR is the only way the consent screen can surface
// them for super-admin operators on a Multisite Network root, which in turn
// is the only way `add-site`'s post-OAuth multisite/list-sites probe (#43)
// can fire end-to-end. Single-site WP installs accept the request — the
// adapter simply won't grant scopes the OAuth user lacks WP capability for,
// so single-site UX is preserved.
const DEFAULT_SCOPE =
  'abilities:read abilities:write abilities:multisite:read abilities:multisite:write';
const DEFAULT_LOOPBACK_TIMEOUT_MS = 5 * 60_000;

class OAuthClient extends EventEmitter {
  /**
   * @param {object} args
   * @param {string} args.siteUrl                                   Canonical site URL
   * @param {string} args.clientName                                e.g. "<user>'s Operator (host.local)"
   * @param {string} args.softwareVersion                           Bridge package version
   * @param {string|string[]} [args.scope]                          Default 'abilities:read abilities:write'
   * @param {string} [args.resource]                                RFC 8707 resource indicator. If omitted, derived from prMetadata.
   * @param {object} args.identityProvider                          BridgeIdentityProvider
   * @param {object} [args.capabilityPin]                           { firstSeenAt: ISO } — pass when site is OAuth-pinned
   * @param {boolean} [args.allowInsecure]
   * @param {object} [args.loopback]                                LoopbackServer override (DI for tests)
   * @param {object} [args.deps]                                    DI of low-level helpers (tests)
   * @param {number} [args.loopbackTimeoutMs]
   * @param {number} [args.timeoutMs]                               HTTP timeout for non-loopback calls
   */
  constructor(args) {
    super();
    if (!args || typeof args.siteUrl !== 'string') {
      throw new Error('OAuthClient requires siteUrl');
    }
    if (typeof args.clientName !== 'string' || !args.clientName) {
      throw new Error('OAuthClient requires clientName');
    }
    if (typeof args.softwareVersion !== 'string' || !args.softwareVersion) {
      throw new Error('OAuthClient requires softwareVersion');
    }
    if (!args.identityProvider || typeof args.identityProvider.getClientId !== 'function') {
      throw new Error('OAuthClient requires identityProvider with BridgeIdentityProvider shape');
    }

    this.siteUrl = args.siteUrl;
    this.clientName = args.clientName;
    this.softwareVersion = args.softwareVersion;
    this.scope = args.scope || DEFAULT_SCOPE;
    this.resource = args.resource || null;
    this.identityProvider = args.identityProvider;
    this.capabilityPin = args.capabilityPin || null;
    this.allowInsecure = !!args.allowInsecure;
    this.loopbackTimeoutMs = args.loopbackTimeoutMs || DEFAULT_LOOPBACK_TIMEOUT_MS;
    this.timeoutMs = args.timeoutMs;

    // Dependency injection seams — production callers don't pass these.
    const deps = args.deps || {};
    this._discover = deps.discover || discover;
    this._register = deps.register || register;
    this._postForm = deps.postForm || postForm;
    this._openBrowser = deps.openBrowser || openBrowser;
    this._LoopbackServer = deps.LoopbackServer || LoopbackServer;
    this._loopbackOverride = args.loopback || null;

    this.state = STATES.IDLE;
    this._lastError = null;
  }

  // ---------------------------------------------------------------------
  // State helpers
  // ---------------------------------------------------------------------

  _transition(to, data) {
    const from = this.state;
    this.state = to;
    const payload = { from, to, data: data || null };
    this.emit(EVENTS.STATE, payload);
    this.emit(to, payload);
  }

  _progress(message, data) {
    this.emit(EVENTS.PROGRESS, { state: this.state, message, data: data || null });
  }

  _fail(err) {
    this._lastError = err;
    this._transition(STATES.FAILED, { error: err });
    this.emit(EVENTS.FAILED, { error: err, state: STATES.FAILED });
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Run the full state machine. Resolves with the result on success, throws
   * on failure (the 'failed' event is emitted first so subscribers see the
   * terminal state before the rejection propagates).
   *
   * @returns {Promise<{
   *   tokens: object,
   *   scopes: string[],
   *   clientId: string,
   *   asMetadata: object,
   *   prMetadata: object|null,
   *   capabilityPin: {firstSeenAt: string, lastConfirmedAt: string},
   *   resource: string|null,
   * }>}
   */
  async run() {
    if (TERMINAL_STATES.has(this.state)) {
      throw new Error(`OAuthClient.run() called on terminal state: ${this.state}`);
    }
    try {
      const discovered = await this._runDiscover();
      const registered = await this._runRegister(discovered);
      const consent = await this._runAwaitConsent(discovered, registered);
      const exchanged = await this._runExchange(discovered, registered, consent);
      const result = this._buildResult(discovered, registered, exchanged);
      this._transition(STATES.COMPLETE, result);
      this.emit(EVENTS.COMPLETE, result);
      return result;
    } catch (err) {
      const wrapped = err instanceof AuthError ? err : new AuthError(err.message, { cause: err, state: this.state });
      this._fail(wrapped);
      throw wrapped;
    }
  }

  // ---------------------------------------------------------------------
  // State implementations
  // ---------------------------------------------------------------------

  async _runDiscover() {
    this._transition(STATES.DISCOVERING, { siteUrl: this.siteUrl });
    const pinnedFirstSeenAt = this.capabilityPin && this.capabilityPin.firstSeenAt
      ? this.capabilityPin.firstSeenAt
      : null;
    const discovered = await this._discover(this.siteUrl, {
      pinned: !!this.capabilityPin,
      pinnedFirstSeenAt,
      allowInsecure: this.allowInsecure,
      timeoutMs: this.timeoutMs,
    });
    this._progress('discovery_succeeded', {
      asMetadataUrl: discovered.asMetadataUrl,
      probeResults: discovered.probeResults,
    });
    return discovered;
  }

  async _runRegister(discovered) {
    this._transition(STATES.REGISTERING, {
      registrationEndpoint: discovered.asMetadata.registration_endpoint,
    });

    // H-8: never reuse a persisted client_id from this code path.
    //
    // The previous early-return looked up identityProvider.getClientId() and
    // returned the persisted client_id without checking whether the registered
    // loopback redirect_uri's port matched the live loopback port. v1.0 was
    // safe by accident because FreshEachTimeIdentityProvider.getClientId()
    // always returns null. v1.1 (Option C, persistent client_id per Appendix
    // H.3.2) would have surfaced the bug: a stale persisted client_id whose
    // server-side registered redirect_uri pinned a port no longer in use
    // would cause the next /oauth/authorize to fail redirect_uri_valid().
    //
    // Defensive guard: clear any persisted client_id before DCR. v1.0
    // FreshEachTime is a no-op; v1.1+ implementations of clearClientId() get
    // a chance to remove a stale entry before we mint a new one. Reuse paths
    // that *already know* their loopback port matches the registration must
    // not flow through _runRegister — they need their own short-circuit at
    // the OAuthClient.run() level.
    await this.identityProvider.clearClientId(this.siteUrl);

    if (!discovered.asMetadata.registration_endpoint) {
      throw new AuthError('Authorization server metadata missing registration_endpoint', {
        code: 'no_registration_endpoint', state: STATES.REGISTERING,
      });
    }

    // We need a redirect_uri to register. Spin up the loopback server now
    // so its port is known to DCR (even though we don't await callbacks
    // until later).
    const expectedState = generateState();
    const loopback = this._loopbackOverride || new this._LoopbackServer({ expectedState });
    await loopback.start();
    this._loopback = loopback;
    this._expectedState = expectedState;

    let registration;
    try {
      registration = await this._register({
        registrationEndpoint: discovered.asMetadata.registration_endpoint,
        clientName: this.clientName,
        redirectUri: loopback.redirectUri,
        scope: this.scope,
        softwareVersion: this.softwareVersion,
        allowInsecure: this.allowInsecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      await loopback.stop().catch(() => {});
      throw err;
    }

    await this.identityProvider.persistClientId(this.siteUrl, registration.clientId);
    this._progress('registered', { clientId: registration.clientId });
    return registration;
  }

  async _runAwaitConsent(discovered, registered) {
    if (!this._loopback) {
      throw new AuthError('Internal error: loopback server not started', { code: 'internal_error' });
    }
    const pkce = generatePkce();
    this._pkce = pkce;

    const resource = this.resource
      || (discovered.prMetadata && discovered.prMetadata.resource)
      || null;

    const authorizeUrl = new URL(discovered.asMetadata.authorization_endpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registered.clientId);
    authorizeUrl.searchParams.set('redirect_uri', this._loopback.redirectUri);
    authorizeUrl.searchParams.set('scope', Array.isArray(this.scope) ? this.scope.join(' ') : this.scope);
    authorizeUrl.searchParams.set('state', this._expectedState);
    authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
    authorizeUrl.searchParams.set('code_challenge_method', pkce.method);
    if (resource) authorizeUrl.searchParams.set('resource', resource);

    this._transition(STATES.AWAITING_CONSENT, {
      authorizeUrl: authorizeUrl.toString(),
      redirectUri: this._loopback.redirectUri,
    });

    // Launch browser as a side-effect and wait for the loopback callback.
    // We swallow browser-launch errors because the caller may already have
    // displayed the URL for manual paste (e.g. headless SSH session).
    this._openBrowser(authorizeUrl.toString()).catch((err) => {
      this._progress('browser_launch_failed', { error: err.message });
    });

    let callback;
    try {
      callback = await this._loopback.waitForCallback({ timeoutMs: this.loopbackTimeoutMs });
    } finally {
      await this._loopback.stop().catch(() => {});
    }
    this._progress('callback_received', { codePresent: !!callback.code });
    return { ...callback, resource };
  }

  async _runExchange(discovered, registered, consent) {
    this._transition(STATES.EXCHANGING, { tokenEndpoint: discovered.asMetadata.token_endpoint });

    const params = {
      grant_type: 'authorization_code',
      code: consent.code,
      redirect_uri: this._loopback ? this._loopback.redirectUri : undefined,
      client_id: registered.clientId,
      code_verifier: this._pkce.verifier,
    };
    if (consent.resource) params.resource = consent.resource;
    // Strip undefined.
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];

    let res;
    try {
      res = await this._postForm(discovered.asMetadata.token_endpoint, params, {
        allowInsecure: this.allowInsecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw new TokenExchangeError(`Token exchange request failed: ${err.message}`, {
        cause: err, state: STATES.EXCHANGING,
      });
    }
    if (res.statusCode < 200 || res.statusCode >= 300 || !res.json) {
      throw new TokenExchangeError(`Token endpoint returned ${res.statusCode}`, {
        cause: { statusCode: res.statusCode, body: res.body, json: res.json },
        state: STATES.EXCHANGING,
      });
    }
    if (typeof res.json.access_token !== 'string') {
      throw new TokenExchangeError('Token response missing access_token', {
        cause: res.json, state: STATES.EXCHANGING,
      });
    }
    return res.json;
  }

  _buildResult(discovered, registered, tokens) {
    const now = new Date().toISOString();
    const grantedScope = typeof tokens.scope === 'string'
      ? tokens.scope.split(/\s+/).filter(Boolean)
      : (Array.isArray(this.scope) ? this.scope : String(this.scope).split(/\s+/).filter(Boolean));

    return {
      tokens,
      scopes: grantedScope,
      clientId: registered.clientId,
      asMetadata: discovered.asMetadata,
      asMetadataUrl: discovered.asMetadataUrl,
      prMetadata: discovered.prMetadata,
      prMetadataUrl: discovered.prMetadataUrl,
      capabilityPin: {
        firstSeenAt: this.capabilityPin && this.capabilityPin.firstSeenAt
          ? this.capabilityPin.firstSeenAt
          : now,
        lastConfirmedAt: now,
      },
      resource: this.resource || (discovered.prMetadata && discovered.prMetadata.resource) || null,
    };
  }
}

module.exports = { OAuthClient, DEFAULT_SCOPE };
