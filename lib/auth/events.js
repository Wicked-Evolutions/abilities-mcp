'use strict';

/**
 * State machine constants and event names for the OAuth flow.
 *
 * Per design doc (architectural-constraint section): the bridge OAuth flow is
 * an event-emitting state machine, not a one-shot function. The CLI subscribes
 * and prints progress lines. A future GUI subscribes and renders progress UI.
 * Same machine, different observers.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const STATES = Object.freeze({
  IDLE: 'idle',
  DISCOVERING: 'discovering',
  REGISTERING: 'registering',
  AWAITING_CONSENT: 'awaiting_consent',
  EXCHANGING: 'exchanging',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

const TERMINAL_STATES = new Set([STATES.COMPLETE, STATES.FAILED]);

/**
 * Auth-status enum used in wp-sites.json v2 (Appendix F.5).
 */
const AUTH_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  PENDING_REAUTH: 'pending-reauth',
});

/**
 * Events emitted on the OAuth state machine. Consumers can listen to:
 *   - 'state'    : every transition, payload `{ from, to, data }`
 *   - 'progress' : sub-step info inside a state (e.g. discovery probe results)
 *   - 'error'    : non-fatal warnings during the flow
 *   - 'complete' : terminal success, payload `{ tokens, scopes, ... }`
 *   - 'failed'   : terminal failure, payload `{ error, state }`
 *   - one event per state name (e.g. 'discovering', 'registering', ...)
 *     with the same data payload as the 'state' event.
 */
const EVENTS = Object.freeze({
  STATE: 'state',
  PROGRESS: 'progress',
  ERROR: 'error',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

module.exports = { STATES, TERMINAL_STATES, AUTH_STATUS, EVENTS };
