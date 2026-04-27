'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

/**
 * Minimal HTTP/JSON helper for OAuth endpoint calls.
 *
 * Behavior:
 *   - HTTPS-required for non-localhost hosts; HTTP allowed only when
 *     `allowInsecure: true` and the host is loopback.
 *   - Default 30s timeout (Appendix H.2.1 mandate for token-manager; we mirror
 *     it here for parity).
 *   - Does NOT follow redirects on token / register / revoke / discovery
 *     endpoints (mirrors H.2.3 posture).
 *   - Returns `{ statusCode, headers, body, json }` where `json` is parsed
 *     when content-type indicates JSON, else null.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const DEFAULT_TIMEOUT_MS = 30_000;

function _buildOptions(parsed, method, headers, isHttps) {
  return {
    method,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers,
  };
}

/**
 * Send an HTTP(S) request and return the parsed response.
 * @param {object} args
 * @param {string} args.url
 * @param {string} args.method                  GET | POST
 * @param {object} [args.headers]
 * @param {string|Buffer|null} [args.body]
 * @param {boolean} [args.allowInsecure]
 * @param {number}  [args.timeoutMs]
 * @param {object}  [args.httpsAgent]           test injection
 * @returns {Promise<{statusCode:number, headers:object, body:string, json:object|null}>}
 */
function request(args) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(args.url); }
    catch (err) { reject(new Error(`Invalid URL: ${args.url}`)); return; }

    const isHttps = parsed.protocol === 'https:';
    const isHttp = parsed.protocol === 'http:';
    if (!isHttps && !isHttp) {
      reject(new Error(`URL must be http(s): ${args.url}`));
      return;
    }
    const isLocal = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1';
    if (isHttp && !(isLocal && args.allowInsecure)) {
      reject(new Error(`HTTPS required for ${args.url}`));
      return;
    }

    const headers = Object.assign({ 'Accept': 'application/json' }, args.headers || {});
    if (args.body && !headers['Content-Length']) {
      headers['Content-Length'] = Buffer.byteLength(args.body);
    }

    const mod = isHttps ? https : http;
    const reqOpts = _buildOptions(parsed, args.method || 'GET', headers, isHttps);
    reqOpts.timeout = args.timeoutMs || DEFAULT_TIMEOUT_MS;
    if (args.httpsAgent && isHttps) reqOpts.agent = args.httpsAgent;

    const req = mod.request(reqOpts, (res) => {
      // Do not auto-follow redirects on auth endpoints.
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        const ctype = (res.headers['content-type'] || '').toLowerCase();
        if (ctype.includes('json') && body.length > 0) {
          try { json = JSON.parse(body); } catch { /* leave null */ }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body, json });
      });
      res.on('error', (err) => reject(err));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => req.destroy(new Error(`Request timed out at ${reqOpts.timeout}ms: ${args.url}`)));
    if (args.body) req.write(args.body);
    req.end();
  });
}

/**
 * POST application/x-www-form-urlencoded — used by /oauth/token (RFC 6749).
 */
async function postForm(url, params, opts = {}) {
  const body = new URLSearchParams(params).toString();
  return request({
    url,
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      opts.headers || {}
    ),
    body,
    allowInsecure: opts.allowInsecure,
    timeoutMs: opts.timeoutMs,
    httpsAgent: opts.httpsAgent,
  });
}

/**
 * POST application/json — used by /oauth/register (RFC 7591).
 */
async function postJson(url, body, opts = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return request({
    url,
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      opts.headers || {}
    ),
    body: payload,
    allowInsecure: opts.allowInsecure,
    timeoutMs: opts.timeoutMs,
    httpsAgent: opts.httpsAgent,
  });
}

/** GET — used by L2 GET-before-POST probes. */
async function getJson(url, opts = {}) {
  return request({
    url,
    method: 'GET',
    headers: opts.headers,
    allowInsecure: opts.allowInsecure,
    timeoutMs: opts.timeoutMs,
    httpsAgent: opts.httpsAgent,
  });
}

module.exports = { request, postForm, postJson, getJson, DEFAULT_TIMEOUT_MS };
