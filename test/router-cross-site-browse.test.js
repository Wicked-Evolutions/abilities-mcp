'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { McpRouter } = require('../lib/router');
const { ToolCatalog } = require('../lib/tool-catalog');

/**
 * McpRouter — site-accurate wp_browse_tools / wp_load_tools (C1).
 *
 * wp_browse_tools {site: <non-default>} must report THAT site's catalog,
 * fetched in isolation, without mutating the global default-site ToolCatalog
 * and without forwarding the internal tools/list response to the client.
 *
 * wp_load_tools {site: <non-default>} must activate nothing and return guidance
 * (per C2: no per-site direct-tool activation).
 *
 * Default-site behavior (site omitted or site === defaultSite) is unchanged.
 */

// Default-site catalog (the bridge caches this from the connected default site).
const DEFAULT_TOOLS = [
  { name: 'content-list' },
  { name: 'content-get' },
  { name: 'media-list' },
  { name: 'mcp-adapter-discover-abilities' },
  { name: 'mcp-adapter-get-ability-info' },
  { name: 'mcp-adapter-execute-ability' },
];

// A DISTINCT catalog for the non-default site — different categories so any
// accidental leakage into the global catalog is visible.
const NON_DEFAULT_TOOLS = [
  { name: 'fluent-crm-list-contacts' },
  { name: 'fluent-crm-add-contact' },
  { name: 'fluent-crm-update-contact' },
  { name: 'surecart-ecommerce-get-store' },
  { name: 'mcp-adapter-discover-abilities' },
];

function makeRouter({ crossSiteTools = NON_DEFAULT_TOOLS, failFetch = false } = {}) {
  const sent = [];
  const transportSends = [];
  const config = {
    defaultSite: 'wickedevolutions',
    sites: { wickedevolutions: {}, helenawillow: {} },
    toolFilter: { enabled: true },
  };
  const catalog = new ToolCatalog(config);
  catalog.cacheTools(DEFAULT_TOOLS);

  let router;
  const pool = {
    setHandshakeCache() {},
    async getTransport(site) {
      return {
        send(line) {
          transportSends.push({ site, line });
          if (failFetch) return; // never responds → exercises the timeout/no-leak path
          const req = JSON.parse(line);
          // Simulate the non-default site's adapter returning its own catalog.
          setImmediate(() => {
            router.handleTransportMessage(
              { jsonrpc: '2.0', id: req.id, result: { tools: crossSiteTools } },
              null,
            );
          });
        },
      };
    },
  };

  router = new McpRouter({
    config,
    siteKeys: ['wickedevolutions', 'helenawillow'],
    isMultiSite: true,
    pool,
    catalog,
    sendToClient: (s) => sent.push(s),
    log: () => {},
  });
  return { router, sent, catalog, transportSends };
}

function call(router, id, name, args) {
  return router._handleBridgeToolCall({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args || {} },
  });
}

function responseText(sent, id) {
  for (const raw of sent) {
    const parsed = JSON.parse(raw);
    if (parsed.id === id) return parsed.result.content[0].text;
  }
  throw new Error(`no response found for id ${id}`);
}

describe('McpRouter — wp_browse_tools cross-site (C1)', () => {
  it('returns the non-default site categories, labeled scoped to that site', async () => {
    const { router, sent } = makeRouter();
    await call(router, 10, 'wp_browse_tools', { site: 'helenawillow' });

    const text = responseText(sent, 10);
    assert.match(text, /scoped to "helenawillow"/i);
    assert.match(text, /browse-only/i);
    assert.match(text, /fluent-crm \(3 tools\)/);
    // `surecart-ecommerce-get-store` → category `surecart-ecommerce` (the
    // compound prefix is registered, so it no longer folds into `surecart`).
    // This aligns the bridge browse summary with the adapter's registered
    // category and its discover histogram.
    assert.match(text, /surecart-ecommerce \(1 tools\)/);
    assert.match(text, /Total: 5 tools in 3 categories on "helenawillow"/);
    // Points cross-site execution at the adapter meta-tools.
    assert.match(text, /mcp-adapter-discover-abilities \{ site: "helenawillow"/);
    assert.match(text, /mcp-adapter-execute-ability \{ site: "helenawillow"/);
  });

  it('does NOT include the default site categories in the cross-site view', async () => {
    const { router, sent } = makeRouter();
    await call(router, 11, 'wp_browse_tools', { site: 'helenawillow' });
    const text = responseText(sent, 11);
    // 'content' / 'media' belong to the default catalog, not helenawillow's.
    assert.doesNotMatch(text, /\bcontent \(/);
    assert.doesNotMatch(text, /\bmedia \(/);
  });

  it('does NOT mutate the global default-site ToolCatalog', async () => {
    const { router, catalog } = makeRouter();

    const fullToolsRef = catalog.fullTools;
    const categoriesBefore = Object.keys(catalog.categories).sort();
    const activeBefore = [...catalog.activeCategories].sort();

    await call(router, 12, 'wp_browse_tools', { site: 'helenawillow' });

    assert.equal(catalog.fullTools, fullToolsRef, 'fullTools reference unchanged');
    assert.equal(catalog.fullTools.length, DEFAULT_TOOLS.length, 'fullTools length unchanged');
    assert.deepEqual(Object.keys(catalog.categories).sort(), categoriesBefore,
      'category index unchanged');
    assert.deepEqual([...catalog.activeCategories].sort(), activeBefore,
      'activeCategories unchanged');
    // The non-default categories must NOT have leaked into the global index.
    assert.ok(!('fluent-crm' in catalog.categories), 'fluent-crm did not leak into global catalog');
    assert.ok(!('surecart-ecommerce' in catalog.categories), 'surecart did not leak into global catalog');
  });

  it('never forwards the isolated tools/list response to the client', async () => {
    const { router, sent } = makeRouter();
    await call(router, 13, 'wp_browse_tools', { site: 'helenawillow' });

    // Exactly one client message — the browse result. The internal fetch's
    // tools/list response (with a `bridge-xsite-tools-list-*` id) must never be
    // sent, and no client message may carry a result.tools array.
    assert.equal(sent.length, 1, 'only the browse result reaches the client');
    for (const raw of sent) {
      const parsed = JSON.parse(raw);
      assert.ok(
        typeof parsed.id !== 'string' || !parsed.id.startsWith('bridge-xsite-'),
        'internal isolated-fetch id never reaches the client',
      );
      assert.ok(
        !(parsed.result && Array.isArray(parsed.result.tools)),
        'no tools/list array is forwarded to the client from a cross-site browse',
      );
    }
    // And the in-flight map is drained after resolution.
    assert.equal(router._isolatedFetches.size, 0, 'no leaked pending fetch entries');
  });

  it('rejects an unknown site with the available-site list', async () => {
    const { router, sent, transportSends } = makeRouter();
    await call(router, 14, 'wp_browse_tools', { site: 'nope' });
    const text = responseText(sent, 14);
    assert.match(text, /Unknown site "nope"/);
    assert.match(text, /wickedevolutions, helenawillow/);
    assert.equal(transportSends.length, 0, 'no transport fetch attempted for an unknown site');
  });
});

describe('McpRouter — wp_browse_tools default site (unchanged)', () => {
  it('site omitted → default-site catalog, labeled scoped to defaultSite', async () => {
    const { router, sent, transportSends } = makeRouter();
    await call(router, 20, 'wp_browse_tools', {});
    const text = responseText(sent, 20);
    assert.match(text, /scoped to defaultSite \(wickedevolutions\)/i);
    assert.match(text, /content \(2 tools\)/);
    assert.equal(transportSends.length, 0, 'default-site browse makes no cross-site fetch');
  });

  it('site === defaultSite → identical to the omitted case', async () => {
    const { router, sent, transportSends } = makeRouter();
    await call(router, 21, 'wp_browse_tools', { site: 'wickedevolutions' });
    const text = responseText(sent, 21);
    assert.match(text, /scoped to defaultSite \(wickedevolutions\)/i);
    assert.match(text, /content \(2 tools\)/);
    assert.equal(transportSends.length, 0, 'default-site browse makes no cross-site fetch');
  });
});

describe('McpRouter — wp_load_tools cross-site (C1 / C2 guard)', () => {
  it('non-default site activates nothing and returns guidance', async () => {
    const { router, sent, catalog, transportSends } = makeRouter();
    const activeBefore = [...catalog.activeCategories].sort();

    await call(router, 30, 'wp_load_tools', { site: 'helenawillow', categories: ['fluent-crm'] });

    const text = responseText(sent, 30);
    assert.match(text, /applies only to the connected default site \("wickedevolutions"\)/);
    assert.match(text, /Nothing was activated for "helenawillow"/);
    assert.match(text, /mcp-adapter-discover-abilities \{ site: "helenawillow"/);
    assert.match(text, /mcp-adapter-execute-ability \{ site: "helenawillow"/);
    assert.doesNotMatch(text, /Activated:/);

    assert.deepEqual([...catalog.activeCategories].sort(), activeBefore,
      'activeCategories unchanged by a cross-site load attempt');
    assert.equal(transportSends.length, 0, 'cross-site load makes no fetch — it is pure guidance');
  });

  it('default site load still activates a known category', async () => {
    const { router, sent, catalog } = makeRouter();
    await call(router, 31, 'wp_load_tools', { site: 'wickedevolutions', categories: ['content'] });
    const text = responseText(sent, 31);
    assert.match(text, /Activated: content/);
    assert.ok(catalog.activeCategories.has('content'), 'content activated on the default site');
  });
});
