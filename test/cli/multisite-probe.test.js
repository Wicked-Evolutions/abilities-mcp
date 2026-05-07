'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  probeMultisite,
  PROBE_PER_PAGE,
  PROBE_PAGE_CAP,
} = require('../../lib/cli/multisite-probe');

/**
 * probeMultisite — pagination across multisite/list-sites pages (Issue #49).
 *
 * The probe must accumulate items across pages 1..N until either a partial
 * page returns or body-level total/total_pages metadata signals completion.
 * Networks larger than PROBE_PAGE_CAP × PROBE_PER_PAGE = 5,000 sites must
 * fail loud rather than silently truncate.
 *
 * Tests drive the probe via the `deps.request` injection seam so the loop
 * runs without a real HTTP server. Each test captures the call sequence
 * (page + per_page args per invocation) so a future regression where, e.g.,
 * the `page` param is dropped surfaces at the protocol layer before the
 * outcome layer.
 */

const SITE_URL = 'https://network.example.com';
const ENDPOINT = 'https://network.example.com/wp-json/mcp/mcp-adapter-default-server';
const ACCESS_TOKEN = 'AT-test';

function makeSubsite(i) {
  // i = 1 → network root. i > 1 → subdomain subsite. Per #70, the network
  // root item is skipped by buildMultisiteBlock (no synthetic `main`
  // slug), so block size in these pagination tests is N - 1 not N.
  if (i === 1) {
    return { blog_id: 1, domain: 'network.example.com', path: '/', url: 'https://network.example.com' };
  }
  return {
    blog_id: i,
    domain: `sub${i}.network.example.com`,
    path: '/',
    url: `https://sub${i}.network.example.com`,
  };
}

function makeNetwork(n) {
  const sites = [];
  for (let i = 1; i <= n; i++) sites.push(makeSubsite(i));
  return sites;
}

/**
 * Build a request fn that:
 *   - Responds to `initialize` and `notifications/initialized` with empty {result:{}}.
 *   - Responds to `tools/call` for `multisite/list-sites` by paginating `sites`
 *     according to the incoming `params.arguments.{page,per_page}`.
 *   - Records every `tools/call` invocation in `calls[]` for protocol assertions.
 *   - Optional `withTotal: true` adds payload.total + payload.total_pages so
 *     the loop can terminate via metadata instead of partial-page fallback.
 *
 * `forceFullPages: true` returns exactly per_page items per page regardless
 * of actual remainder — used to drive the cap-exceeded path.
 */
function makePaginatedRequest(sites, opts = {}) {
  const { withTotal = false, forceFullPages = false } = opts;
  const calls = [];
  async function request(message) {
    if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: {} };
    if (message.method === 'notifications/initialized') return null;
    if (message.method !== 'tools/call') {
      throw new Error(`unexpected method: ${message.method}`);
    }
    const args = message.params.arguments || {};
    calls.push({ page: args.page, per_page: args.per_page });
    const page = args.page || 1;
    const perPage = args.per_page || PROBE_PER_PAGE;
    let pageItems;
    if (forceFullPages) {
      pageItems = [];
      const baseIdx = (page - 1) * perPage;
      for (let j = 0; j < perPage; j++) pageItems.push(makeSubsite(baseIdx + j + 1));
    } else {
      const start = (page - 1) * perPage;
      pageItems = sites.slice(start, start + perPage);
    }
    const payload = { sites: pageItems };
    if (withTotal) {
      payload.total = sites.length;
      payload.total_pages = Math.ceil(sites.length / perPage);
    }
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    };
  }
  return { request, calls };
}

describe('probeMultisite — pagination (Issue #49)', () => {
  it('100-site network — page 1 full + page 2 empty terminates loop (no metadata)', async () => {
    const { request, calls } = makePaginatedRequest(makeNetwork(100));
    const r = await probeMultisite({
      endpoint: ENDPOINT,
      accessToken: ACCESS_TOKEN,
      siteUrl: SITE_URL,
      deps: { request },
    });
    assert.equal(r.reason, 'multisite-root');
    // 100 fixture items - 1 (network root, skipped per #70) = 99 in block.
    assert.equal(Object.keys(r.block).length, 99);
    // The page param is REQUIRED — pinned via call sequence so a future
    // regression where page defaults to 1 silently fails here, not in
    // the data assertion above.
    //
    // When the adapter exposes no body-level total, we accept one redundant
    // probe-page call when page 1 happens to be exactly full. The cost is
    // bounded to a single extra call per probe operation, and the loop
    // terminates on the empty page without writing it to the block. The
    // 'with metadata' test below covers the case where the +1 is avoided.
    assert.deepEqual(calls, [
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
    ]);
  });

  it('101-site network — overflows to page 2, accumulates partial-page items', async () => {
    const { request, calls } = makePaginatedRequest(makeNetwork(101));
    const r = await probeMultisite({
      endpoint: ENDPOINT,
      accessToken: ACCESS_TOKEN,
      siteUrl: SITE_URL,
      deps: { request },
    });
    assert.equal(r.reason, 'multisite-root');
    // 101 fixture items - 1 (network root, skipped per #70) = 100 in block.
    assert.equal(Object.keys(r.block).length, 100,
      'partial page on page 2 (1 item) must NOT be dropped — termination ordering pins this');
    assert.deepEqual(calls, [
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
    ]);
  });

  it('250-site network — three pages, partial on page 3', async () => {
    const { request, calls } = makePaginatedRequest(makeNetwork(250));
    const r = await probeMultisite({
      endpoint: ENDPOINT,
      accessToken: ACCESS_TOKEN,
      siteUrl: SITE_URL,
      deps: { request },
    });
    assert.equal(r.reason, 'multisite-root');
    // 250 fixture items - 1 (network root, skipped per #70) = 249 in block.
    assert.equal(Object.keys(r.block).length, 249);
    assert.deepEqual(calls, [
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
      { page: 3, per_page: 100 },
    ]);
  });

  it('100-site network with total=100 metadata — single page, terminates via total', async () => {
    // With body-level total, the loop terminates without issuing page 2 even
    // when page 1 is exactly full. This avoids the "+1 redundant call" cost
    // in the case the adapter exposes totals.
    const { request, calls } = makePaginatedRequest(makeNetwork(100), { withTotal: true });
    const r = await probeMultisite({
      endpoint: ENDPOINT,
      accessToken: ACCESS_TOKEN,
      siteUrl: SITE_URL,
      deps: { request },
    });
    assert.equal(r.reason, 'multisite-root');
    // 100 fixture items - 1 (network root, skipped per #70) = 99 in block.
    assert.equal(Object.keys(r.block).length, 99);
    assert.deepEqual(calls, [{ page: 1, per_page: 100 }]);
  });

  it('250-site network with total=250 metadata — three pages exactly', async () => {
    const { request, calls } = makePaginatedRequest(makeNetwork(250), { withTotal: true });
    const r = await probeMultisite({
      endpoint: ENDPOINT,
      accessToken: ACCESS_TOKEN,
      siteUrl: SITE_URL,
      deps: { request },
    });
    assert.equal(r.reason, 'multisite-root');
    // 250 fixture items - 1 (network root, skipped per #70) = 249 in block.
    assert.equal(Object.keys(r.block).length, 249);
    assert.deepEqual(calls, [
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
      { page: 3, per_page: 100 },
    ]);
  });

  it('cap-exceeded — full page at page 50, throws probe_cap_exceeded with diagnostic data', async () => {
    // forceFullPages keeps every page at exactly per_page items, so the
    // partial-page fallback never fires and the loop reaches the cap.
    const { request, calls } = makePaginatedRequest([], { forceFullPages: true });
    let caught = null;
    try {
      await probeMultisite({
        endpoint: ENDPOINT,
        accessToken: ACCESS_TOKEN,
        siteUrl: SITE_URL,
        deps: { request },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected probe_cap_exceeded to throw');
    assert.equal(caught.code, 'probe_cap_exceeded');
    assert.match(caught.message, new RegExp(String(PROBE_PAGE_CAP * PROBE_PER_PAGE)),
      'error message must name the cap so an operator hitting it gets a clean diagnostic');
    assert.deepEqual(caught.data, {
      count: PROBE_PAGE_CAP * PROBE_PER_PAGE,
      cap: PROBE_PAGE_CAP * PROBE_PER_PAGE,
    }, 'error data carries accumulated count + cap for operator diagnostics');
    // Pin: cap-exceeded means we requested every page up to and including the cap.
    assert.equal(calls.length, PROBE_PAGE_CAP);
    assert.deepEqual(calls[0], { page: 1, per_page: 100 });
    assert.deepEqual(calls[PROBE_PAGE_CAP - 1], { page: PROBE_PAGE_CAP, per_page: 100 });
  });
});
