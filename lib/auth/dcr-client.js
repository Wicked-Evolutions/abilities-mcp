'use strict';

const { postJson, getJson } = require('./http-json');
const { RegistrationError } = require('./errors');

/**
 * Dynamic Client Registration (RFC 7591) client.
 *
 * Per Appendix F.4 (DCR registration metadata) and H.4.2 (software_id is a
 * self-reported hint), v1.0 sends:
 *
 *   software_id      = "com.wickedevolutions.abilities-mcp"
 *   software_version = read from package.json (currently "1.4.0"; the
 *                      design doc example used "1.0.0", but the spec wording
 *                      defines software_version as "the bridge's current
 *                      version" — we report what we ship as)
 *
 * Per Appendix D.2 L2: "GET probes before POST." We do a courtesy GET on the
 * registration endpoint before POSTing — adapter Phase 1 wires both.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const SOFTWARE_ID = 'com.wickedevolutions.abilities-mcp';
const CLIENT_URI = 'https://wickedevolutions.com/docs/abilities-mcp';
const DEFAULT_GRANT_TYPES = Object.freeze(['authorization_code', 'refresh_token']);
const DEFAULT_RESPONSE_TYPES = Object.freeze(['code']);
const DEFAULT_AUTH_METHOD = 'none'; // public client — PKCE proof-of-possession

/**
 * Build the DCR request body.
 * @param {object} args
 * @param {string} args.clientName
 * @param {string} args.redirectUri
 * @param {string|string[]} args.scope            space-separated scope string OR array
 * @param {string} args.softwareVersion
 * @param {string[]} [args.grantTypes]
 * @param {string[]} [args.responseTypes]
 * @returns {object}
 */
function buildRegistrationBody(args) {
  const scope = Array.isArray(args.scope) ? args.scope.join(' ') : args.scope;
  return {
    client_name: args.clientName,
    redirect_uris: [args.redirectUri],
    token_endpoint_auth_method: DEFAULT_AUTH_METHOD,
    grant_types: args.grantTypes || DEFAULT_GRANT_TYPES,
    response_types: args.responseTypes || DEFAULT_RESPONSE_TYPES,
    scope,
    software_id: SOFTWARE_ID,
    software_version: args.softwareVersion,
    client_uri: CLIENT_URI,
  };
}

/**
 * Register a new OAuth client with the adapter.
 *
 * @param {object} args
 * @param {string} args.registrationEndpoint
 * @param {string} args.clientName
 * @param {string} args.redirectUri
 * @param {string|string[]} args.scope
 * @param {string} args.softwareVersion
 * @param {boolean} [args.skipGetProbe]    Tests can disable.
 * @param {boolean} [args.allowInsecure]
 * @param {number}  [args.timeoutMs]
 * @param {object}  [args.httpsAgent]      test injection
 * @returns {Promise<{clientId: string, raw: object}>}
 */
async function register(args) {
  // L2 GET probe — best-effort, never raises.
  if (!args.skipGetProbe) {
    try {
      await getJson(args.registrationEndpoint, {
        allowInsecure: args.allowInsecure,
        timeoutMs: args.timeoutMs,
        httpsAgent: args.httpsAgent,
      });
    } catch {
      // Ignore — the probe is informational. Real failures show up on POST.
    }
  }

  const body = buildRegistrationBody({
    clientName: args.clientName,
    redirectUri: args.redirectUri,
    scope: args.scope,
    softwareVersion: args.softwareVersion,
  });

  let res;
  try {
    res = await postJson(args.registrationEndpoint, body, {
      allowInsecure: args.allowInsecure,
      timeoutMs: args.timeoutMs,
      httpsAgent: args.httpsAgent,
    });
  } catch (err) {
    throw new RegistrationError(
      `DCR request failed: ${err.message}`,
      { state: 'registering', cause: err }
    );
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new RegistrationError(
      `DCR returned ${res.statusCode} from ${args.registrationEndpoint}`,
      { state: 'registering', cause: { statusCode: res.statusCode, body: res.body } }
    );
  }
  if (!res.json || typeof res.json.client_id !== 'string') {
    throw new RegistrationError(
      `DCR response missing client_id`,
      { state: 'registering', cause: { body: res.body } }
    );
  }

  return { clientId: res.json.client_id, raw: res.json };
}

module.exports = { register, buildRegistrationBody, SOFTWARE_ID, CLIENT_URI };
