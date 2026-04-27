'use strict';

/**
 * Public surface for `lib/auth/`.
 *
 * Every export here maps 1:1 to a future CLI subcommand or is a building
 * block consumed by the state machine. The module is callable from any
 * consumer (CLI today, GUI tomorrow). It contains zero CLI dependencies —
 * no console.log, no process.exit, no readline.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const events = require('./events');
const errors = require('./errors');
const secretStore = require('./secret-store');
const { MemorySecretStore } = require('./memory-secret-store');
const { KeychainSecretStore } = require('./keychain-secret-store');
const bridgeIdentity = require('./bridge-identity-provider');
const { FreshEachTimeIdentityProvider } = require('./fresh-each-time-identity');
const pkce = require('./pkce');
const discoveryClient = require('./discovery-client');
const dcrClient = require('./dcr-client');
const { LoopbackServer, PORT_MIN, PORT_MAX } = require('./loopback-server');
const { openBrowser } = require('./browser-launcher');
const { OAuthClient, DEFAULT_SCOPE } = require('./oauth-client');
const { TokenManager, REFRESH_WINDOW_SECONDS, HTTP_TIMEOUT_MS, MAX_RETRIES } = require('./token-manager');
const schemaV2 = require('./schema-v2');
const configMigration = require('./config-migration');

module.exports = {
  // Constants and enums
  STATES: events.STATES,
  TERMINAL_STATES: events.TERMINAL_STATES,
  AUTH_STATUS: events.AUTH_STATUS,
  EVENTS: events.EVENTS,
  DEFAULT_SCOPE,
  REFRESH_WINDOW_SECONDS,
  HTTP_TIMEOUT_MS,
  MAX_RETRIES,
  PORT_MIN,
  PORT_MAX,
  IDENTITY_BUNDLE_VERSION: bridgeIdentity.IDENTITY_BUNDLE_VERSION,
  SCHEMA_VERSION: schemaV2.SCHEMA_VERSION,
  AUTH_METHODS: schemaV2.AUTH_METHODS,
  VALID_AUTH_STATUS: schemaV2.VALID_AUTH_STATUS,

  // Errors
  AuthError: errors.AuthError,
  DiscoveryError: errors.DiscoveryError,
  CapabilityPinningError: errors.CapabilityPinningError,
  RegistrationError: errors.RegistrationError,
  TokenExchangeError: errors.TokenExchangeError,
  StateMismatchError: errors.StateMismatchError,
  UserDeniedError: errors.UserDeniedError,
  RefreshError: errors.RefreshError,
  SecretStoreError: errors.SecretStoreError,
  MigrationError: errors.MigrationError,

  // Secret store
  SecretStore: {
    KEYCHAIN_REF_SCHEME: secretStore.KEYCHAIN_REF_SCHEME,
    makeRef: secretStore.makeRef,
    parseRef: secretStore.parseRef,
    resolveRef: secretStore.resolveRef,
  },
  MemorySecretStore,
  KeychainSecretStore,

  // Identity
  FreshEachTimeIdentityProvider,

  // Primitives
  pkce,
  discoveryClient,
  dcrClient,
  LoopbackServer,
  openBrowser,

  // Orchestration
  OAuthClient,
  TokenManager,

  // Config schema
  schemaV2,
  configMigration,
};
