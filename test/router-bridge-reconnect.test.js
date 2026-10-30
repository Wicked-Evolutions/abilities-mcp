'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { McpRouter } = require('../lib/router');
const { ToolCatalog } = require('../lib/tool-catalog');

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeRecoveryHarness(opts = {}) {
  const sent = [];
  const requests = [];
  const created = [];
  const promoted = [];
  const cachedCatalogs = [];
  const pages = opts.pages || [
    { tools: [{ name: 'content-list', inputSchema: { type: 'object' } }] },
  ];
  let transport;

  const pool = {
    setHandshakeCache() {},
    async createStagedTransport(site) {
      created.push(site);
      transport = {
        onMessage: null,
        shutdownCalls: 0,
        async connect() {},
        async shutdown() { this.shutdownCalls += 1; },
        send(line) {
          const request = JSON.parse(line);
          requests.push({ site, request });
          if (opts.hang) return;
          const delay = opts.delayMs || 0;
          setTimeout(() => {
            if (!this.onMessage) return;
            if (request.method === 'initialize') {
              this.onMessage(response(request.id, opts.initializeResult || {
                protocolVersion: '2025-06-18', capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1.0.0' },
              }), null);
              return;
            }
            if (request.method === 'tools/list') {
              if (typeof opts.respond === 'function') {
                const custom = opts.respond(request, pages);
                if (custom !== undefined) {
                  if (custom !== null) this.onMessage(custom, null);
                  return;
                }
              }
              const cursor = request.params && request.params.cursor;
              const page = cursor === undefined ? pages[0] : pages.find((p) => p.forCursor === cursor);
              this.onMessage(response(request.id, JSON.parse(JSON.stringify(page || { tools: [] }))), null);
            }
          }, delay);
        },
      };
      return transport;
    },
    promoteStagedTransport(site, staged) { promoted.push({ site, staged }); },
    async getTransport() { return transport; },
  };
  const catalog = opts.catalog || {
    isEnabled: () => true,
    prepareTools: (tools) => ({ tools }),
    installPreparedTools: (prepared) => cachedCatalogs.push(prepared.tools),
    cacheTools: (tools) => cachedCatalogs.push(tools),
    getFilteredTools: () => cachedCatalogs[cachedCatalogs.length - 1] || [],
  };
  const router = new McpRouter({
    config: { defaultSite: 'siteA', sites: { siteA: {}, siteB: {} } },
    siteKeys: ['siteA', 'siteB'],
    isMultiSite: true,
    pool,
    catalog,
    sendToClient: (line) => sent.push(JSON.parse(line)),
    log: () => {},
    recoveryTimeoutMs: opts.recoveryTimeoutMs,
    recoveredCatalogAssemblyTimeoutMs: opts.recoveredCatalogAssemblyTimeoutMs,
  });
  router.enterDegradedMode([{ siteId: 'siteA', reason: 'unavailable' }]);
  router.handleClientMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {} },
  }, '{}');
  router.handleClientMessage({ jsonrpc: '2.0', method: 'initialized', params: {} }, '{}');

  return { router, sent, requests, created, promoted, catalog: cachedCatalogs, catalogImpl: catalog, get transport() { return transport; } };
}

function reconnect(router, id, site = 'siteA') {
  router.handleClientMessage({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'wp_bridge_reconnect', arguments: { site } },
  }, '{}');
}

function callResponse(sent, id) {
  return sent.find((message) => message.id === id);
}

describe('McpRouter — explicit degraded reconnect (#125)', () => {
  it('recovers only the selected site after private initialize and a complete paginated catalog', async () => {
    const h = makeRecoveryHarness({ pages: [
      { tools: [{ name: 'content-list', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
      { forCursor: 'page-2', tools: [{ name: 'media-list', inputSchema: { type: 'object' } }] },
    ] });

    reconnect(h.router, 10, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(h.created.length, 1);
    assert.deepEqual(h.created, ['siteA']);
    assert.equal(h.promoted.length, 1);
    assert.equal(h.router.degraded, false);
    assert.equal(h.router.defaultTransport, h.transport);
    assert.deepEqual(h.catalog[0].map((tool) => tool.name), ['content-list', 'media-list']);
    assert.equal(h.requests.filter((entry) => entry.request.method === 'initialize').length, 1);
    assert.equal(h.requests.filter((entry) => entry.request.method === 'tools/list').length, 2);
    assert.equal(h.requests.every((entry) => entry.site === 'siteA'), true, 'never contacts another configured site');
    assert.equal(callResponse(h.sent, 10).result.isError, undefined);
    assert.equal(h.sent.filter((message) => message.method === 'notifications/tools/list_changed').length, 1);
    assert.equal(h.sent.some((message) => message.id >= 1000000000), false, 'private responses never reach client');
  });

  it('rejects unknown targets before any transport or credential work', async () => {
    const h = makeRecoveryHarness();
    reconnect(h.router, 11, 'https://untrusted.example');
    await tick();
    assert.equal(h.created.length, 0);
    assert.equal(callResponse(h.sent, 11).result.isError, true);
  });

  it('does not reserve high JSON-RPC ids from ordinary client responses', () => {
    const h = makeRecoveryHarness();
    h.router.handleTransportMessage(response(1000000999, { content: [{ type: 'text', text: 'normal high id' }] }), null);
    assert.equal(callResponse(h.sent, 1000000999).result.content[0].text, 'normal high id');
  });

  it('binds private correlation to the staged transport and drops unexpected staged messages', async () => {
    const h = makeRecoveryHarness({ hang: true, recoveryTimeoutMs: 100 });
    reconnect(h.router, 111, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const privateId = h.requests.find((entry) => entry.request.method === 'initialize').request.id;

    // A matching id from the normal transport is an ordinary client response,
    // not a private recovery reply. It cannot advance the attempt.
    h.router.handleTransportMessage(response(privateId, {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'wrong-transport', version: '1.0.0' },
    }), null);
    assert.ok(callResponse(h.sent, privateId));
    assert.equal(h.router._recoveryRequests.has(privateId), true);

    h.transport.onMessage(response(42, { ignored: true }), null);
    assert.equal(h.sent.some((message) => message.id === 42), false, 'unrecognized staged message remains private');
    h.router.beginShutdown();
  });

  it('coalesces same-target callers, rejects a conflict, and notifies once', async () => {
    const h = makeRecoveryHarness({ delayMs: 10 });
    reconnect(h.router, 12, 'siteA');
    reconnect(h.router, 13, 'siteA');
    reconnect(h.router, 14, 'siteB');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(h.created.length, 1);
    assert.equal(h.requests.filter((entry) => entry.request.method === 'initialize').length, 1);
    assert.equal(callResponse(h.sent, 12).result.isError, undefined);
    assert.equal(callResponse(h.sent, 13).result.isError, undefined);
    assert.equal(callResponse(h.sent, 14).result.isError, true);
    assert.equal(h.sent.filter((message) => message.method === 'notifications/tools/list_changed').length, 1);
  });

  it('times out without promotion and fences a late private response', async () => {
    const h = makeRecoveryHarness({ hang: true, recoveryTimeoutMs: 15 });
    reconnect(h.router, 15, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(callResponse(h.sent, 15).result.isError, true);
    assert.equal(h.promoted.length, 0);
    assert.equal(h.router.degraded, true);

    h.transport.onMessage(response(1000000001, {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    }), null);
    assert.equal(h.sent.some((message) => message.id === 1000000001), false);
  });

  it('keeps a timed-out attempt busy until staged cleanup and credential work actually settle', async () => {
    const h = makeRecoveryHarness({ hang: true, recoveryTimeoutMs: 15 });
    reconnect(h.router, 151, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 5));
    let releaseCleanup;
    const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
    h.transport.shutdown = async () => cleanupGate;

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(callResponse(h.sent, 151).result.isError, true, 'caller sees the shared deadline');
    reconnect(h.router, 152, 'siteA');
    reconnect(h.router, 153, 'siteB');
    await tick();
    assert.equal(h.created.length, 1, 'same target cannot create a second attempt while cleanup is pending');
    assert.equal(callResponse(h.sent, 153).result.isError, true, 'conflicting target is rejected while busy');

    releaseCleanup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.router._recoveryAttempt, null, 'attempt retires only after real cleanup settlement');
  });

  it('does not promote invalid initialize, malformed catalog, or repeated pagination', async () => {
    for (const opts of [
      { initializeResult: { protocolVersion: 'wrong', capabilities: { tools: {} } } },
      { pages: [{ tools: [{ inputSchema: { type: 'object' } }] }] },
      { pages: [
        { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'again' },
        { forCursor: 'again', tools: [{ name: 'second', inputSchema: { type: 'object' } }], nextCursor: 'again' },
      ] },
    ]) {
      const h = makeRecoveryHarness(opts);
      reconnect(h.router, 16, 'siteA');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(h.promoted.length, 0);
      assert.equal(h.router.degraded, true);
      assert.equal(callResponse(h.sent, 16).result.isError, true);
    }
  });

  it('prepares a valid constructor-named tool before promotion and leaves live state untouched when preparation fails', async () => {
    const realCatalog = new ToolCatalog({ toolFilter: { enabled: true, alwaysIncludeCategories: ['constructor'] } });
    const valid = makeRecoveryHarness({
      catalog: realCatalog,
      pages: [{ tools: [{ name: 'constructor', inputSchema: { type: 'object' } }] }],
    });
    reconnect(valid.router, 161, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(valid.promoted.length, 1);
    assert.deepEqual(realCatalog.fullTools.map((tool) => tool.name), ['constructor']);

    const initialTools = [{ name: 'content-list' }];
    const failingCatalog = {
      fullTools: initialTools,
      isEnabled: () => true,
      prepareTools() { throw new Error('catalog preparation failed'); },
      installPreparedTools() { throw new Error('must not install'); },
      getFilteredTools() { return initialTools; },
    };
    const failed = makeRecoveryHarness({ catalog: failingCatalog });
    reconnect(failed.router, 162, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(failed.promoted.length, 0);
    assert.equal(failed.router.defaultTransport, null);
    assert.equal(failed.router.degraded, true);
    assert.equal(failingCatalog.fullTools, initialTools);
  });

  it('preserves the complete recovered catalog through the first client tools/list refresh', async () => {
    const h = makeRecoveryHarness({ pages: [
      { tools: [{ name: 'content-list', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
      { forCursor: 'page-2', tools: [{ name: 'media-list', inputSchema: { type: 'object' } }] },
    ] });
    reconnect(h.router, 18, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.promoted.length, 1, 'recovery completed before the client refresh');
    assert.equal(h.router.degraded, false);
    assert.equal(h.router.defaultTransport, h.transport);
    const refreshRequest = { jsonrpc: '2.0', id: 19, method: 'tools/list', params: {} };
    h.router.handleClientMessage(refreshRequest, JSON.stringify(refreshRequest));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.requests.filter((entry) => entry.request.id === 19).length, 1, 'refresh reached promoted transport');
    const refresh = callResponse(h.sent, 19);
    const names = refresh.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('content-list'));
    assert.ok(names.includes('media-list'));
    assert.ok(names.includes('wp_bridge_reconnect'));
    assert.equal(Object.hasOwn(refresh.result, 'nextCursor'), false, 'complete refresh cannot retain the remote first-page cursor');
    assert.equal(refresh.result.tools.find((tool) => tool.name === 'content-list').inputSchema.properties.site.type, 'string');

    // An already-running client may nevertheless send the stale later cursor.
    // That response must not replace the complete catalog used by browse/load.
    const stalePageRequest = { jsonrpc: '2.0', id: 21, method: 'tools/list', params: { cursor: 'page-2' } };
    h.router.handleClientMessage(stalePageRequest, JSON.stringify(stalePageRequest));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const cachedNames = h.catalog[h.catalog.length - 1].map((tool) => tool.name);
    assert.ok(cachedNames.includes('content-list'));
    assert.ok(cachedNames.includes('media-list'));
  });

  it('does not duplicate bridge-owned names supplied by a remote page', async () => {
    const h = makeRecoveryHarness({ pages: [{ tools: [
      { name: 'content-list', inputSchema: { type: 'object' } },
      { name: 'wp_bridge_health', inputSchema: { type: 'object' } },
    ] }] });
    reconnect(h.router, 181, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const list = { jsonrpc: '2.0', id: 182, method: 'tools/list', params: {} };
    h.router.handleClientMessage(list, JSON.stringify(list));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callResponse(h.sent, 182).result.tools.filter((tool) => tool.name === 'wp_bridge_health').length, 1);
  });

  it('keeps recovered complete categories coherent across later pagination and load/unload notifications', async () => {
    const catalog = new ToolCatalog({ toolFilter: { enabled: true, alwaysIncludeCategories: ['content'] } });
    const h = makeRecoveryHarness({
      catalog,
      pages: [
        { tools: [{ name: 'content-list', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
        { forCursor: 'page-2', tools: [{ name: 'media-list', inputSchema: { type: 'object' } }] },
      ],
    });
    reconnect(h.router, 30, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const initial = { jsonrpc: '2.0', id: 31, method: 'tools/list', params: {} };
    h.router.handleClientMessage(initial, JSON.stringify(initial));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(callResponse(h.sent, 31).result.tools.map((tool) => tool.name).filter((name) => !name.startsWith('wp_')), ['content-list']);

    // A stale second-page request cannot mutate or duplicate the retained
    // complete catalog.
    const stale = { jsonrpc: '2.0', id: 311, method: 'tools/list', params: { cursor: 'page-2' } };
    h.router.handleClientMessage(stale, JSON.stringify(stale));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callResponse(h.sent, 311).error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), ['content-list', 'media-list']);

    h.router.handleClientMessage({ jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: { name: 'wp_load_tools', arguments: { categories: ['media'] } } }, '{}');
    assert.equal(callResponse(h.sent, 32).result.isError, undefined);
    assert.ok(h.sent.some((message) => message.method === 'notifications/tools/list_changed'));

    const later = { jsonrpc: '2.0', id: 33, method: 'tools/list', params: {} };
    h.router.handleClientMessage(later, JSON.stringify(later));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pageTwo = { jsonrpc: '2.0', id: 34, method: 'tools/list', params: { cursor: 'page-2' } };
    h.router.handleClientMessage(pageTwo, JSON.stringify(pageTwo));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), ['content-list', 'media-list']);
    const aggregate = [33, 34].flatMap((id) => callResponse(h.sent, id).result.tools.map((tool) => tool.name));
    assert.equal(new Set(aggregate).size, aggregate.length, 'each remote and bridge tool appears once across client pages');
    for (const name of ['content-list', 'media-list', 'wp_bridge_health', 'wp_bridge_reconnect', 'wp_browse_tools', 'wp_load_tools']) {
      assert.ok(aggregate.includes(name), `aggregate includes ${name}`);
    }

    h.router.handleClientMessage({ jsonrpc: '2.0', id: 35, method: 'tools/call',
      params: { name: 'wp_browse_tools', arguments: {} } }, '{}');
    assert.match(callResponse(h.sent, 35).result.content[0].text, /media \(1 tools\)/);
    h.router.handleClientMessage({ jsonrpc: '2.0', id: 36, method: 'tools/call',
      params: { name: 'wp_load_tools', arguments: { categories: [], deactivate: ['media'] } } }, '{}');
    const afterUnload = { jsonrpc: '2.0', id: 37, method: 'tools/list', params: {} };
    h.router.handleClientMessage(afterUnload, JSON.stringify(afterUnload));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(callResponse(h.sent, 37).result.tools.map((tool) => tool.name).filter((name) => !name.startsWith('wp_')), ['content-list']);
    const afterUnloadPageTwo = { jsonrpc: '2.0', id: 38, method: 'tools/list', params: { cursor: 'page-2' } };
    h.router.handleClientMessage(afterUnloadPageTwo, JSON.stringify(afterUnloadPageTwo));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const unloadedAggregate = [37, 38].flatMap((id) => callResponse(h.sent, id).result.tools.map((tool) => tool.name));
    assert.equal(new Set(unloadedAggregate).size, unloadedAggregate.length);
    assert.equal(unloadedAggregate.includes('media-list'), false, 'unloaded category stays filtered on every page');
  });

  it('preserves the previous complete catalog on malformed, error, and repeated-cursor client pages', async () => {
    const config = { pages: [
      { tools: [{ name: 'content-list', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
      { forCursor: 'page-2', tools: [{ name: 'media-list', inputSchema: { type: 'object' } }] },
    ] };
    const catalog = new ToolCatalog({ toolFilter: { enabled: true, alwaysIncludeCategories: ['content'] } });
    config.catalog = catalog;
    const h = makeRecoveryHarness(config);
    reconnect(h.router, 60, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const initial = { jsonrpc: '2.0', id: 61, method: 'tools/list', params: {} };
    h.router.handleClientMessage(initial, JSON.stringify(initial));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const previous = catalog.fullTools.map((tool) => tool.name);

    config.respond = (request) => request.method === 'tools/list'
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'remote failure' } }
      : undefined;
    const errorPage = { jsonrpc: '2.0', id: 62, method: 'tools/list', params: {} };
    h.router.handleClientMessage(errorPage, JSON.stringify(errorPage));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callResponse(h.sent, 62).error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);

    config.respond = (request) => request.method === 'tools/list'
      ? { jsonrpc: '2.0', id: request.id, result: { malformed: true } }
      : undefined;
    const malformed = { jsonrpc: '2.0', id: 63, method: 'tools/list', params: {} };
    h.router.handleClientMessage(malformed, JSON.stringify(malformed));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callResponse(h.sent, 63).error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);

    config.respond = (request) => {
      if (request.method !== 'tools/list') return undefined;
      return response(request.id, { tools: [{ name: request.params && request.params.cursor ? 'content-next' : 'content-root' }], nextCursor: 'loop' });
    };
    const root = { jsonrpc: '2.0', id: 64, method: 'tools/list', params: {} };
    h.router.handleClientMessage(root, JSON.stringify(root));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const loop = { jsonrpc: '2.0', id: 65, method: 'tools/list', params: { cursor: 'loop' } };
    h.router.handleClientMessage(loop, JSON.stringify(loop));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callResponse(h.sent, 65).error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);
  });

  it('expires a client-owned catalog assembly without allowing its late page to satisfy a reused id', async () => {
    const config = {
      recoveredCatalogAssemblyTimeoutMs: 50,
    };
    const h = makeRecoveryHarness(config);
    reconnect(h.router, 70, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 25));
    config.respond = (request) => {
      if (request.method !== 'tools/list') return undefined;
      if (!request.params || request.params.cursor === undefined) return response(request.id, { tools: [{ name: 'content-root' }], nextCursor: 'late' });
      return null;
    };
    const recoveryRefresh = { jsonrpc: '2.0', id: 710, method: 'tools/list', params: {} };
    h.router.handleClientMessage(recoveryRefresh, JSON.stringify(recoveryRefresh));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const first = { jsonrpc: '2.0', id: 71, method: 'tools/list', params: {} };
    h.router.handleClientMessage(first, JSON.stringify(first));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = { jsonrpc: '2.0', id: 72, method: 'tools/list', params: { cursor: 'late' } };
    h.router.handleClientMessage(pending, JSON.stringify(pending));
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(callResponse(h.sent, 72).error.code, -32603);
    h.router.handleClientMessage(pending, JSON.stringify(pending));
    assert.equal(h.requests.filter((entry) => entry.request.id === 72).length, 1, 'id reuse remains blocked until late transport settlement');
    h.transport.onMessage(response(72, { tools: [{ name: 'late-tool' }] }), null);
    assert.equal(h.sent.filter((message) => message.id === 72).length, 2, 'late response is suppressed after the timeout error');
  });

  it('bounds unique endless pages and oversized catalogs before replacing the retained cache', async () => {
    const h = makeRecoveryHarness();
    reconnect(h.router, 73, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const retained = h.catalog[h.catalog.length - 1];
    const assembly = h.router._startRecoveredCatalogAssembly();
    for (let page = 0; page < 100; page += 1) {
      h.router._appendRecoveredCatalogPage(assembly, {
        tools: [{ name: `content-${page}` }], nextCursor: `cursor-${page}`,
      });
    }
    assert.throws(() => h.router._appendRecoveredCatalogPage(assembly, {
      tools: [{ name: 'content-overflow' }], nextCursor: 'cursor-overflow',
    }));
    h.router._failRecoveredCatalogAssembly(assembly);
    assert.equal(h.catalog[h.catalog.length - 1], retained, 'page-limit failure retains the previous catalog');

    const oversized = h.router._startRecoveredCatalogAssembly();
    assert.throws(() => h.router._appendRecoveredCatalogPage(oversized, {
      tools: Array.from({ length: 5001 }, (_unused, index) => ({ name: `media-${index}` })),
    }));
    h.router._failRecoveredCatalogAssembly(oversized);
    assert.equal(h.catalog[h.catalog.length - 1], retained, 'tool-limit failure retains the previous catalog');
  });

  it('forwards a former private id only after a real client request, then drops an unsolicited duplicate', async () => {
    const h = makeRecoveryHarness();
    reconnect(h.router, 20, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const privateId = h.requests.find((entry) => entry.request.method === 'initialize').request.id;
    const clientRequest = { jsonrpc: '2.0', id: privateId, method: 'ping', params: {} };
    h.router.handleClientMessage(clientRequest, JSON.stringify(clientRequest));
    h.transport.onMessage(response(privateId, { content: [{ type: 'text', text: 'ordinary collision' }] }), null);
    assert.equal(callResponse(h.sent, privateId).result.content[0].text, 'ordinary collision');
    h.transport.onMessage(response(privateId, { content: [{ type: 'text', text: 'late duplicate' }] }), null);
    assert.equal(h.sent.filter((message) => message.id === privateId).length, 1);

    const aliasRequest = {
      jsonrpc: '2.0', id: privateId, method: 'tools/call',
      params: { name: 'content-list', arguments: { site: 'siteB' } },
    };
    h.router.handleClientMessage(aliasRequest, JSON.stringify(aliasRequest));
    await tick();
    h.transport.onMessage(response(privateId, { content: [{ type: 'text', text: 'alias collision' }] }), null);
    assert.equal(h.sent.filter((message) => message.id === privateId).length, 2);
    h.transport.onMessage(response(privateId, { content: [{ type: 'text', text: 'alias duplicate' }] }), null);
    assert.equal(h.sent.filter((message) => message.id === privateId).length, 2);
  });

  it('cancels a staged attempt during shutdown and never allows a late promotion', async () => {
    const h = makeRecoveryHarness({ hang: true, recoveryTimeoutMs: 100 });
    reconnect(h.router, 17, 'siteA');
    await tick();
    h.router.beginShutdown();
    await tick();
    assert.equal(callResponse(h.sent, 17).result.isError, true);
    assert.equal(h.promoted.length, 0);
    assert.equal(h.router.degraded, true);
  });
});
