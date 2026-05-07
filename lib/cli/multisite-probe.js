'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

/**
 * Multisite Network root probe for `abilities-mcp add-site`.
 *
 * After OAuth completes, call `multisite/list-sites` against the freshly
 * authenticated bridge connection. If the URL points to a Multisite Network
 * root, build the `multisite` block (slug → subsite-URL map) the bridge's
 * dot-notation routing already expects (see `lib/config.js:resolveSiteKey`,
 * `lib/connection-pool.js:_findExistingHttpTransport`). If the URL is a
 * single-site install, the OAuth user lacks `manage_network_options`, or the
 * call fails for any other reason, the probe returns null / a structured
 * error so `add-site` can degrade gracefully without writing the block.
 *
 * Schema (verified against routing read paths):
 *   site.multisite = { [slug]: subsiteUrlString }
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const PROBE_PROTOCOL_VERSION = '2025-06-18';
const PROBE_PER_PAGE = 100;
const PROBE_TIMEOUT_MS = 30000;
// Page cap = 50 pages × 100/page = 5,000 sites. Networks larger than this
// are an exceptional case that should engage maintainers rather than silently
// override; not exposed as an env shim (Issue #49).
const PROBE_PAGE_CAP = 50;

/**
 * @typedef {object} ProbeResult
 * @property {object|null} block      Multisite block, or null when no block
 *                                    should be written (single-site / empty).
 * @property {string} reason          One of: 'multisite-root', 'single-site',
 *                                    'tool-not-registered', 'empty-list'.
 */

/**
 * @param {object} opts
 * @param {string} opts.endpoint      MCP resource URL (from prMetadata.resource).
 * @param {string} opts.accessToken   Freshly minted OAuth access token.
 * @param {string} opts.siteUrl       Parent network-root URL (parsedUrl.origin).
 * @param {function} [opts.log]       Logger.
 * @param {object} [opts.deps]
 * @param {function} [opts.deps.request]  Inject for tests; replaces the inline
 *                                        bearer JSON-RPC client. Receives the
 *                                        full message and resolves the parsed
 *                                        JSON-RPC response (or rejects with a
 *                                        structured error).
 * @returns {Promise<ProbeResult>}
 */
async function probeMultisite(opts) {
  const { endpoint, accessToken, siteUrl, log } = opts;
  const logger = typeof log === 'function' ? log : function noop() {};

  if (!endpoint) {
    const e = new Error('multisite probe: no MCP endpoint available');
    e.code = 'no_endpoint';
    throw e;
  }
  if (!accessToken) {
    const e = new Error('multisite probe: no access token available');
    e.code = 'no_access_token';
    throw e;
  }

  const client = (opts.deps && opts.deps.request)
    ? new InjectedClient(opts.deps.request)
    : new BearerJsonRpcClient(endpoint, accessToken, logger);

  await client.initialize();

  // Page through multisite/list-sites until the network is fully covered
  // (Issue #49). Networks with >100 sites previously got a truncated block
  // because the probe issued a single per_page=100 call.
  //
  // Termination order matters: when a page returns fewer than per_page items
  // (or exposes a body-level total/total_pages we've reached), we still
  // accumulate that page's items first, then exit the loop. Dropping the
  // partial page's items would silently lose subsites.
  let items = null;
  let totalKnown = null;
  let totalPagesKnown = null;
  for (let page = 1; page <= PROBE_PAGE_CAP; page++) {
    // Adapter exposes the ability as kebab-case `multisite-list-sites`
    // (verified via tools/list against wickedevolutions). The slash form
    // shipped in v1.5.4 (Issue #54 same-files extension) — masked by the
    // session-token rejection until the bridge fix above surfaced it.
    const toolResp = await client.callTool('multisite-list-sites', {
      per_page: PROBE_PER_PAGE,
      page,
    });
    const payload = parseToolResponse(toolResp);
    const pageItems = extractSites(payload);
    if (pageItems === null) {
      // Malformed payload on page 1 → preserve the existing 'empty-list'
      // contract that downstream callers (add-site) already handle.
      // On a later page, treat as "no more items" and stop.
      if (page === 1) { items = null; break; }
      break;
    }
    if (items === null) items = [];
    items.push(...pageItems);

    // Body-level total / total_pages take precedence — they're authoritative
    // when present. Without them we use the partial-page fallback.
    const meta = extractMeta(payload);
    if (meta.total != null) totalKnown = meta.total;
    if (meta.totalPages != null) totalPagesKnown = meta.totalPages;

    const fullPage = pageItems.length === PROBE_PER_PAGE;
    const reachedKnownTotal = totalKnown != null && items.length >= totalKnown;
    const reachedKnownTotalPages = totalPagesKnown != null && page >= totalPagesKnown;
    if (!fullPage || reachedKnownTotal || reachedKnownTotalPages) break;

    // Full page AND no metadata signal we're done AND we're at the cap.
    // This is the "5,000+ site network" case — fail loud rather than write
    // a silently truncated block.
    if (page === PROBE_PAGE_CAP) {
      const e = new Error(
        `multisite probe: page cap exceeded (${PROBE_PAGE_CAP} pages × ${PROBE_PER_PAGE}/page = ${PROBE_PAGE_CAP * PROBE_PER_PAGE} sites). ` +
        `This network exceeds the supported probe size; contact maintainers.`
      );
      e.code = 'probe_cap_exceeded';
      e.data = { count: items.length, cap: PROBE_PAGE_CAP * PROBE_PER_PAGE };
      throw e;
    }
  }

  if (items === null) {
    return { block: null, reason: 'empty-list' };
  }
  if (items.length === 0) {
    return { block: null, reason: 'empty-list' };
  }
  if (items.length === 1) {
    // Only the network root came back — treat as single-site for routing
    // purposes. Operators can still call `multisite/*` abilities at the
    // network level; dot-notation routing isn't useful with no subsites.
    return { block: null, reason: 'single-site' };
  }

  const block = buildMultisiteBlock(siteUrl, items);
  if (!block || Object.keys(block).length === 0) {
    return { block: null, reason: 'empty-list' };
  }
  return { block, reason: 'multisite-root' };
}

/**
 * Build the multisite block (slug → subsite URL) from a `multisite/list-sites`
 * response. Pure function — no I/O, no logging. Exported so `add-site.js`
 * tests can verify the schema-mapping logic in isolation.
 */
function buildMultisiteBlock(parentSiteUrl, items) {
  let parentHost;
  try { parentHost = new URL(parentSiteUrl).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }

  const block = {};
  const used = new Set();
  for (const item of items) {
    if (!item || typeof item.url !== 'string' || item.url.length === 0) continue;
    const baseSlug = deriveSubsiteSlug(parentHost, item);
    if (!baseSlug) continue;
    const slug = uniqueSlug(baseSlug, used, item);
    used.add(slug);
    block[slug] = item.url;
  }
  return block;
}

/**
 * Map a `multisite/list-sites` item to a slug usable for dot-notation
 * routing. Subdomain mode → first label of the subdomain. Path mode →
 * first segment of the path. Mapped-domain subsites → first label of
 * the domain.
 *
 * Issue #70: returns null when `itemDomain === parentHost && itemPath
 * is empty`. That case used to synthesize a `'main'` slug intended to
 * point at the network root, but in subdomain-style multisite the only
 * blog matching parent host is the parent subsite itself — so the
 * resulting `<site>.main` URL was the source subsite, not the root,
 * silently routing dot-notation calls to the wrong context. Skipping
 * the slug means: in subdomain-style the network root is reachable via
 * its domain-label slug from the fall-through (`<site>.<root-label>`);
 * in path-style the network root is the parent itself and reachable as
 * `<site>` (no dot). A first-class `'main' → blog_id 1` alias is
 * post-alpha work.
 */
function deriveSubsiteSlug(parentHost, item) {
  const itemDomain = String(item.domain || '').toLowerCase().replace(/^www\./, '');
  const itemPath = String(item.path || '/').replace(/^\/+|\/+$/g, '');

  if (itemDomain === parentHost) {
    if (itemPath === '') return null;
    return itemPath.split('/')[0];
  }
  if (itemDomain.endsWith('.' + parentHost)) {
    const prefix = itemDomain.slice(0, itemDomain.length - parentHost.length - 1);
    const first = prefix.split('.')[0];
    return first || null;
  }
  // Mapped / different domain — fall back to first label
  const first = itemDomain.split('.')[0];
  return first || null;
}

function uniqueSlug(base, used, item) {
  if (!used.has(base)) return base;
  // Disambiguate with blog_id when slugs collide (e.g. two subsites whose
  // first path segments match). Never silently overwrite a previously
  // mapped subsite.
  const blogId = item && item.blog_id;
  if (blogId !== undefined && blogId !== null) {
    const candidate = `${base}-${blogId}`;
    if (!used.has(candidate)) return candidate;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function parseToolResponse(resp) {
  if (resp && resp.error) {
    const e = new Error(resp.error.message || 'JSON-RPC error');
    e.code = mapJsonRpcErrorCode(resp.error.code, resp.error.message);
    e.jsonrpcCode = resp.error.code;
    throw e;
  }
  const result = resp && resp.result;
  if (!result) {
    const e = new Error('multisite/list-sites: empty result');
    e.code = 'empty_result';
    throw e;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  let payload = null;
  if (first && first.type === 'text' && typeof first.text === 'string') {
    try { payload = JSON.parse(first.text); }
    catch { payload = { _raw: first.text }; }
  }

  if (result.isError) {
    const errMsg = (payload && (payload.error || payload._raw))
      || (first && first.text)
      || 'tool error';
    const errCode = (payload && payload.error_code) || 'tool_error';
    const e = new Error(errMsg);
    e.code = mapAbilityErrorCode(errCode, errMsg);
    e.abilityCode = errCode;
    e.data = payload && payload.error_data;
    throw e;
  }

  return payload || result;
}

function extractSites(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.sites)) return payload.sites;
  if (payload.data && Array.isArray(payload.data.sites)) return payload.data.sites;
  return null;
}

/**
 * Extract pagination metadata from a multisite/list-sites payload, if the
 * adapter exposes it on the body. The adapter may surface totals on HTTP
 * headers instead — body-only is the supported channel for the probe loop;
 * absence is fine because the partial-page fallback handles termination.
 */
function extractMeta(payload) {
  if (!payload || typeof payload !== 'object') return { total: null, totalPages: null };
  const root = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const total = numericOrNull(root.total);
  const totalPages = numericOrNull(root.total_pages);
  return { total, totalPages };
}

function numericOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function mapJsonRpcErrorCode(code, message) {
  // -32601 = Method not found → tool not registered (single-site install)
  if (code === -32601) return 'tool_not_registered';
  if (typeof message === 'string' && /unknown\s+tool/i.test(message)) return 'tool_not_registered';
  return 'jsonrpc_error';
}

function mapAbilityErrorCode(abilityCode, message) {
  const code = String(abilityCode || '').toLowerCase();
  if (code === 'rest_forbidden_context'
      || code === 'rest_forbidden'
      || code === 'permission_denied'
      || code === 'forbidden_context'
      || code.indexOf('forbidden') !== -1) {
    return 'permission_denied';
  }
  if (code === 'rest_no_route' || code === 'not_multisite') {
    return 'tool_not_registered';
  }
  if (typeof message === 'string' && /manage_network_options|insufficient.*capabilit|forbidden/i.test(message)) {
    return 'permission_denied';
  }
  return 'tool_error';
}

// ---------------------------------------------------------------------------
// Bearer JSON-RPC client — minimal MCP handshake + tools/call over HTTP.
// Distinct from OAuthHttpTransport: this runs once during add-site with a
// fresh in-memory access token, so it skips TokenManager + queue/batch.
// ---------------------------------------------------------------------------

class BearerJsonRpcClient {
  constructor(endpoint, accessToken, log) {
    this.url = new URL(endpoint);
    this.accessToken = accessToken;
    this.log = log;
    this.module = this.url.protocol === 'https:' ? https : http;
    this.sessionId = null;
    this.sessionToken = null; // Mcp-Session-Token (HMAC, echoed back on every request)
    this.cookies = new Map();
    this._idCounter = 1;
  }

  async initialize() {
    const initResp = await this._post({
      jsonrpc: '2.0',
      id: this._idCounter++,
      method: 'initialize',
      params: {
        protocolVersion: PROBE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'abilities-mcp-add-site', version: '1.5.4' },
      },
    });
    if (initResp && initResp.error) {
      const e = new Error(initResp.error.message || 'initialize failed');
      e.code = 'initialize_failed';
      e.jsonrpcCode = initResp.error.code;
      throw e;
    }
    await this._post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }

  callTool(name, args) {
    return this._post({
      jsonrpc: '2.0',
      id: this._idCounter++,
      method: 'tools/call',
      params: { name, arguments: args || {} },
    });
  }

  _post(message) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(message);
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      // Echo the per-session HMAC token captured from initialize. The
      // adapter's HttpSessionValidator rejects any non-initialize request
      // missing this header as session-fixation defense — see Issue #54
      // and the equivalent handling in lib/transports/http-transport.js.
      if (this.sessionToken) headers['Mcp-Session-Token'] = this.sessionToken;
      if (this.cookies.size > 0) {
        headers['Cookie'] = Array.from(this.cookies.entries())
          .map(([k, v]) => `${k}=${v}`).join('; ');
      }

      const req = this.module.request({
        hostname: this.url.hostname,
        port: this.url.port || (this.url.protocol === 'https:' ? 443 : 80),
        path: this.url.pathname + this.url.search,
        method: 'POST',
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const newSession = res.headers['mcp-session-id'];
          if (newSession) this.sessionId = newSession;
          const newSessionToken = res.headers['mcp-session-token'];
          if (newSessionToken) this.sessionToken = newSessionToken;
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            const list = Array.isArray(setCookie) ? setCookie : [setCookie];
            for (const raw of list) {
              const nv = raw.split(';')[0].trim();
              const eq = nv.indexOf('=');
              if (eq > 0) this.cookies.set(nv.slice(0, eq), nv.slice(eq + 1));
            }
          }
          if (res.statusCode === 401) {
            const e = new Error('multisite probe: HTTP 401 (token rejected)');
            e.code = 'unauthorized';
            return reject(e);
          }
          if (res.statusCode === 403) {
            const e = new Error('multisite probe: HTTP 403 (forbidden)');
            e.code = 'permission_denied';
            return reject(e);
          }
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text.trim()) return resolve(null);
          let parsed;
          try { parsed = JSON.parse(text); }
          catch (err) {
            const e = new Error(`multisite probe: response parse error: ${err.message}`);
            e.code = 'parse_error';
            return reject(e);
          }
          // Tolerate single-element JSON-RPC batch responses (some servers
          // wrap a single response in an array).
          if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
          resolve(parsed);
        });
      });

      req.setTimeout(PROBE_TIMEOUT_MS, () => {
        req.destroy(new Error('multisite probe: request timeout'));
      });
      req.on('error', (err) => {
        const e = new Error(`multisite probe: ${err.message}`);
        e.code = 'network_error';
        e.cause = err;
        reject(e);
      });
      req.write(body);
      req.end();
    });
  }
}

/**
 * Test injection seam — wraps a function `(message) => Promise<jsonrpcResp>`
 * and presents the same surface (`initialize`, `callTool`) the inline client
 * does so the probe code path is identical.
 */
class InjectedClient {
  constructor(requestFn) {
    this._request = requestFn;
    this._idCounter = 1;
  }
  async initialize() {
    const resp = await this._request({
      jsonrpc: '2.0',
      id: this._idCounter++,
      method: 'initialize',
      params: { protocolVersion: PROBE_PROTOCOL_VERSION, capabilities: {} },
    });
    if (resp && resp.error) {
      const e = new Error(resp.error.message || 'initialize failed');
      e.code = 'initialize_failed';
      e.jsonrpcCode = resp.error.code;
      throw e;
    }
    await this._request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  callTool(name, args) {
    return this._request({
      jsonrpc: '2.0',
      id: this._idCounter++,
      method: 'tools/call',
      params: { name, arguments: args || {} },
    });
  }
}

module.exports = {
  probeMultisite,
  buildMultisiteBlock,
  deriveSubsiteSlug,
  parseToolResponse,
  // Exported for direct testing of the per-session HMAC echo contract
  // (Issue #54). The runtime contract (capture Mcp-Session-Token from
  // initialize and echo on every subsequent request) is observable
  // protocol behavior, not implementation detail.
  BearerJsonRpcClient,
  PROBE_PROTOCOL_VERSION,
  PROBE_PER_PAGE,
  PROBE_PAGE_CAP,
};
