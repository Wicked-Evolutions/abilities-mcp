'use strict';

/**
 * BridgeIdentityProvider — interface contract.
 *
 * Specified in design doc Appendix F.4 (interface) and Appendix H.3.2 (the
 * v1.0 binding amendment that REPLACES the v1.0 implementation shown in F.4).
 *
 * The provider decides whether the bridge presents a stable identity to the
 * adapter across sessions / installs / machines. v1.0 ships the
 * fresh-each-time implementation (force fresh DCR on every flow); v1.1+ may
 * persist client_id same-machine, v1.2+ may export/import across machines.
 *
 * @typedef {object} IdentityBundle
 * @property {1} version
 * @property {string} siteId
 * @property {string} clientId
 * @property {string} exportedAt    ISO 8601
 * @property {string} [signature]   future: HMAC for tamper-detection
 *
 * @typedef {object} BridgeIdentityProvider
 * @property {(siteId: string) => Promise<string|null>}            getClientId
 * @property {(siteId: string, clientId: string) => Promise<void>} persistClientId
 * @property {(siteId: string) => Promise<void>}                   clearClientId
 * @property {(siteId: string) => Promise<IdentityBundle|null>}    exportIdentity
 * @property {(siteId: string, bundle: IdentityBundle) => Promise<void>} importIdentity
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const IDENTITY_BUNDLE_VERSION = 1;

module.exports = { IDENTITY_BUNDLE_VERSION };
