'use strict';

/**
 * Typed error classes for the OAuth flow.
 *
 * Code paths in lib/auth/ MUST throw or emit these instead of writing to
 * stderr. Callers (CLI today, GUI tomorrow) decide how to surface them.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

class AuthError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code]    machine-readable error code
   * @param {string} [opts.state]   state machine state at the time of failure
   * @param {object} [opts.cause]   underlying cause
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = opts.code || 'auth_error';
    if (opts.state) this.state = opts.state;
    if (opts.cause) this.cause = opts.cause;
  }
}

class DiscoveryError extends AuthError {
  constructor(message, opts = {}) {
    super(message, { code: 'discovery_failed', ...opts });
    this.name = 'DiscoveryError';
  }
}

class CapabilityPinningError extends AuthError {
  /**
   * Raised when a previously-pinned OAuth-capable site returns 404 on
   * discovery — per Appendix H.2.3 we fail loud rather than silently
   * downgrading to App Password.
   */
  constructor(message, opts = {}) {
    super(message, { code: 'oauth_capability_lost', ...opts });
    this.name = 'CapabilityPinningError';
  }
}

class RegistrationError extends AuthError {
  constructor(message, opts = {}) {
    super(message, { code: 'registration_failed', ...opts });
    this.name = 'RegistrationError';
  }
}

class TokenExchangeError extends AuthError {
  constructor(message, opts = {}) {
    super(message, { code: 'token_exchange_failed', ...opts });
    this.name = 'TokenExchangeError';
  }
}

class StateMismatchError extends AuthError {
  /** CSRF protection — Appendix H.3.5. Loopback callback `state` did not
   *  match the value the bridge generated for this flow. */
  constructor(message = 'OAuth state parameter mismatch — CSRF protection rejected callback', opts = {}) {
    super(message, { code: 'state_mismatch', ...opts });
    this.name = 'StateMismatchError';
  }
}

class UserDeniedError extends AuthError {
  /** Operator clicked "Deny" on the consent screen. */
  constructor(message = 'Operator denied authorization', opts = {}) {
    super(message, { code: 'access_denied', ...opts });
    this.name = 'UserDeniedError';
  }
}

class RefreshError extends AuthError {
  /** A refresh-token exchange failed with a 4xx — token is unusable.
   *  Caller should mark `auth_status: "expired"` and prompt reauth. */
  constructor(message, opts = {}) {
    super(message, { code: 'refresh_failed', ...opts });
    this.name = 'RefreshError';
  }
}

class SecretStoreError extends AuthError {
  constructor(message, opts = {}) {
    super(message, { code: 'secret_store_error', ...opts });
    this.name = 'SecretStoreError';
  }
}

class MigrationError extends AuthError {
  constructor(message, opts = {}) {
    super(message, { code: 'migration_failed', ...opts });
    this.name = 'MigrationError';
  }
}

module.exports = {
  AuthError,
  DiscoveryError,
  CapabilityPinningError,
  RegistrationError,
  TokenExchangeError,
  StateMismatchError,
  UserDeniedError,
  RefreshError,
  SecretStoreError,
  MigrationError,
};
