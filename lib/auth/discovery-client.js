'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const { DiscoveryError, CapabilityPinningError } = require('./errors');

/**
 * Discovery client for OAuth 2.1 .well-known endpoints.
 *
 * Per design doc:
 *   - L1 (Appendix D.2): MCP TypeScript SDK probes three well-known paths.
 *     We try them in this order until one returns 200 with valid metadata:
 *       1. {origin}/.well-known/oauth-authorization-server{path}
 *       2. {origin}/.well-known/openid-configuration{path}
 *       3. {origin}{path}/.well-known/openid-configuration
 *     The protected-resource metadata lives at {origin}/.well-known/oauth-protected-resource.
 *   - HTTPS-only on .well-known paths (Appendix H.2.3). The discovery client
 *     refuses HTTP URLs unless the caller passes `allowInsecure: true` for
 *     localhost development.
 *   - No redirect-following. A 3xx on a .well-known path is treated as a
 *     non-discovery (move to next candidate). This mitigates Location-header
 *     injection attacks (H.2.3).
 *   - HTTP timeout: 30s read/write (H.2.1 mandate is for token-manager but
 *     we apply the same ceiling here for parity).
 *
 * Capability pinning (Appendix H.2.3):
 *   - On first successful discovery, callers should write
 *     `oauth_capability_pinned.first_seen_at` to site config.
 *   - On every subsequent connection, refresh `last_confirmed_at`.
 *   - If pinned AND discovery returns 404, throw CapabilityPinningError —
 *     do NOT silently downgrade to App Password.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build the L1 probe order for a given site URL.
 *
 * @param {string} siteUrl  e.g. "https://example.com" or "https://example.com/site2"
 * @returns {{authorizationServer: string[], protectedResource: string}}
 */
function buildProbeOrder(siteUrl) {
  const u = new URL(siteUrl);
  const origin = u.origin;
  const pathPart = u.pathname.replace(/\/+$/g, '');

  const authorizationServer = [
    `${origin}/.well-known/oauth-authorization-server${pathPart}`,
    `${origin}/.well-known/openid-configuration${pathPart}`,
    `${origin}${pathPart}/.well-known/openid-configuration`,
  ];

  // De-dupe (when pathPart is empty the three collapse to two distinct URLs).
  const seen = new Set();
  const dedupedAuth = [];
  for (const url of authorizationServer) {
    if (!seen.has(url)) { seen.add(url); dedupedAuth.push(url); }
  }

  const protectedResource = `${origin}/.well-known/oauth-protected-resource`;
  return { authorizationServer: dedupedAuth, protectedResource };
}

/**
 * GET a .well-known URL with explicit security constraints.
 *
 * Returns either { ok: true, json, status, url } or { ok: false, status, url }.
 * Network errors raise.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.allowInsecure]   Localhost-only escape hatch
 * @param {object} [opts.httpsAgent]       Test injection
 */
function getWellKnown(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (err) { reject(new DiscoveryError(`Invalid URL: ${url}`, { cause: err })); return; }

    const isHttps = parsed.protocol === 'https:';
    const isHttp = parsed.protocol === 'http:';
    if (!isHttps && !isHttp) {
      reject(new DiscoveryError(`Discovery URL must be http(s): ${url}`));
      return;
    }
    const isLocal = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1';
    if (isHttp && !(isLocal && opts.allowInsecure)) {
      reject(new DiscoveryError(
        `Discovery refused: HTTPS required for ${url}. ` +
        `Per Appendix H.2.3 the bridge does not perform OAuth discovery over plain HTTP.`
      ));
      return;
    }

    const mod = isHttps ? https : http;
    const requestOpts = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'Accept': 'application/json' },
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    };
    if (opts.httpsAgent && isHttps) requestOpts.agent = opts.httpsAgent;

    const req = mod.request(requestOpts, (res) => {
      // Per H.2.3: do NOT follow redirects on .well-known paths.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        resolve({ ok: false, status: res.statusCode, url, redirected: true });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          resolve({ ok: false, status: res.statusCode, url, body });
          return;
        }
        let json;
        try { json = JSON.parse(body); }
        catch (err) {
          resolve({ ok: false, status: res.statusCode, url, parseError: err.message });
          return;
        }
        resolve({ ok: true, status: res.statusCode, url, json });
      });
      res.on('error', (err) => reject(new DiscoveryError(`Response error from ${url}: ${err.message}`, { cause: err })));
    });

    req.on('error', (err) => reject(new DiscoveryError(`Request failed for ${url}: ${err.message}`, { cause: err })));
    req.on('timeout', () => req.destroy(new DiscoveryError(`Discovery timed out at ${requestOpts.timeout}ms: ${url}`)));
    req.end();
  });
}

/**
 * Validate the shape of an authorization-server metadata document.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validateAsMetadata(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'metadata is not an object' };
  for (const required of ['issuer', 'authorization_endpoint', 'token_endpoint']) {
    if (typeof json[required] !== 'string') {
      return { ok: false, reason: `missing field: ${required}` };
    }
  }
  if (Array.isArray(json.code_challenge_methods_supported)
      && !json.code_challenge_methods_supported.includes('S256')) {
    return { ok: false, reason: 'server does not advertise S256 PKCE support' };
  }
  return { ok: true };
}

/**
 * Validate the shape of a protected-resource metadata document.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validatePrMetadata(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'metadata is not an object' };
  if (typeof json.resource !== 'string') return { ok: false, reason: 'missing field: resource' };
  if (!Array.isArray(json.authorization_servers) || json.authorization_servers.length === 0) {
    return { ok: false, reason: 'missing field: authorization_servers' };
  }
  return { ok: true };
}

/**
 * Run the full discovery flow against a site.
 *
 * @param {string} siteUrl
 * @param {object} [opts]
 * @param {boolean} [opts.pinned]            true if site is already OAuth-pinned (H.2.3)
 * @param {string}  [opts.pinnedFirstSeenAt] for the failure message
 * @param {boolean} [opts.allowInsecure]
 * @param {number}  [opts.timeoutMs]
 * @param {object}  [opts.httpsAgent]        test injection
 * @returns {Promise<{
 *   asMetadata: object,
 *   asMetadataUrl: string,
 *   prMetadata: object|null,
 *   prMetadataUrl: string|null,
 *   probeResults: Array<object>,
 * }>}
 */
async function discover(siteUrl, opts = {}) {
  const probes = buildProbeOrder(siteUrl);
  const probeResults = [];

  let asMetadata = null;
  let asMetadataUrl = null;

  for (const url of probes.authorizationServer) {
    let res;
    try {
      res = await getWellKnown(url, opts);
    } catch (err) {
      probeResults.push({ url, ok: false, error: err.message });
      // HTTPS-required is a configuration error, not a probe miss — surface
      // it immediately so the caller sees the real reason. Per Appendix
      // H.2.3 the bridge does not perform OAuth discovery over plain HTTP.
      if (/HTTPS required/i.test(err.message)) throw err;
      // Other hard errors (network, TLS) — record and continue to next
      // candidate path.
      continue;
    }
    probeResults.push({ url, ok: res.ok, status: res.status, redirected: res.redirected });
    if (res.ok) {
      const validation = validateAsMetadata(res.json);
      if (!validation.ok) {
        probeResults[probeResults.length - 1].invalid = validation.reason;
        continue;
      }
      asMetadata = res.json;
      asMetadataUrl = url;
      break;
    }
  }

  if (!asMetadata) {
    const all404 = probeResults.length > 0 && probeResults.every((p) => p.status === 404);
    if (all404 && opts.pinned) {
      throw new CapabilityPinningError(
        `Site ${siteUrl} previously supported OAuth (first seen ${opts.pinnedFirstSeenAt || 'unknown'}) ` +
        `but now reports no OAuth. This may indicate a network attack. ` +
        `Refusing to silently downgrade to App Password.`,
        { state: 'discovering' }
      );
    }
    throw new DiscoveryError(
      `OAuth discovery failed for ${siteUrl} — none of ${probes.authorizationServer.length} probe URLs returned valid metadata.`,
      { state: 'discovering', cause: { probeResults } }
    );
  }

  // Protected-resource metadata is informative but not strictly required to
  // proceed. We try once at the canonical path.
  let prMetadata = null;
  let prMetadataUrl = null;
  try {
    const res = await getWellKnown(probes.protectedResource, opts);
    if (res.ok) {
      const validation = validatePrMetadata(res.json);
      if (validation.ok) {
        prMetadata = res.json;
        prMetadataUrl = probes.protectedResource;
      }
    }
  } catch {
    // Non-fatal — proceed without protected-resource metadata.
  }

  return { asMetadata, asMetadataUrl, prMetadata, prMetadataUrl, probeResults };
}

module.exports = {
  buildProbeOrder,
  getWellKnown,
  validateAsMetadata,
  validatePrMetadata,
  discover,
  DEFAULT_TIMEOUT_MS,
};
