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

async function waitFor(predicate, label, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForResponse(harness, id, label = `response ${id}`) {
  await waitFor(() => callResponse(harness.sent, id) !== undefined, label);
  const message = callResponse(harness.sent, id);
  assert.equal(message.jsonrpc, '2.0', `${label} must be a JSON-RPC response`);
  assert.equal(message.id, id, `${label} must retain its request id`);
  return message;
}

async function waitForRecovered(harness, id, label = `reconnect ${id}`) {
  const message = await waitForResponse(harness, id, label);
  assert.ok(message.result, `${label} must return a result`);
  assert.notEqual(message.result.isError, true, `${label} must succeed`);
  await waitFor(
    () => harness.promoted.length === 1 && harness.router.degraded === false && harness.router.defaultTransport === harness.transport,
    `${label} promotion`
  );
  return message;
}

describe('McpRouter — explicit degraded reconnect (#125)', () => {
  it('recovers only the selected site after private initialize and a complete paginated catalog', async () => {
    const h = makeRecoveryHarness({ pages: [
      { tools: [{ name: 'content-list', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
      { forCursor: 'page-2', tools: [{ name: 'media-list', inputSchema: { type: 'object' } }] },
    ] });

    reconnect(h.router, 10, 'siteA');
    await waitForRecovered(h, 10);

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
    await waitFor(() => h.requests.some((entry) => entry.request.method === 'initialize'), 'staged initialize request');
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
    await waitForResponse(h, 12, 'first coalesced reconnect');
    await waitForResponse(h, 13, 'second coalesced reconnect');
    await waitForResponse(h, 14, 'conflicting reconnect');
    await waitFor(() => h.sent.some((message) => message.method === 'notifications/tools/list_changed'), 'reconnect catalog notification');

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
    await waitFor(() => h.transport !== undefined, 'staged transport before cleanup override');
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
    await waitFor(() => h.router._recoveryAttempt === null, 'timed-out attempt cleanup settlement');
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
      const failure = await waitForResponse(h, 16, 'invalid recovery failure');
      assert.equal(h.promoted.length, 0);
      assert.equal(h.router.degraded, true);
      assert.equal(failure.result.isError, true);
    }
  });

  it('prepares a valid constructor-named tool before promotion and leaves live state untouched when preparation fails', async () => {
    const realCatalog = new ToolCatalog({ toolFilter: { enabled: true, alwaysIncludeCategories: ['constructor'] } });
    const valid = makeRecoveryHarness({
      catalog: realCatalog,
      pages: [{ tools: [{ name: 'constructor', inputSchema: { type: 'object' } }] }],
    });
    reconnect(valid.router, 161, 'siteA');
    await waitForRecovered(valid, 161, 'constructor recovery');
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
    const failedResponse = await waitForResponse(failed, 162, 'failed catalog preparation');
    assert.equal(failed.promoted.length, 0);
    assert.equal(failed.router.defaultTransport, null);
    assert.equal(failed.router.degraded, true);
    assert.equal(failingCatalog.fullTools, initialTools);
    assert.equal(failedResponse.result.isError, true);
  });

  it('preserves the complete recovered catalog through the first client tools/list refresh', async () => {
    const h = makeRecoveryHarness({ pages: [
      { tools: [{ name: 'content-list', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
      { forCursor: 'page-2', tools: [{ name: 'media-list', inputSchema: { type: 'object' } }] },
    ] });
    reconnect(h.router, 18, 'siteA');
    await waitForRecovered(h, 18);
    assert.equal(h.promoted.length, 1, 'recovery completed before the client refresh');
    assert.equal(h.router.degraded, false);
    assert.equal(h.router.defaultTransport, h.transport);
    const refreshRequest = { jsonrpc: '2.0', id: 19, method: 'tools/list', params: {} };
    h.router.handleClientMessage(refreshRequest, JSON.stringify(refreshRequest));
    const refresh = await waitForResponse(h, 19, 'first recovered tools/list refresh');
    assert.equal(h.requests.filter((entry) => entry.request.id === 19).length, 1, 'refresh reached promoted transport');
    assert.ok(refresh.result && Array.isArray(refresh.result.tools), 'first recovered refresh must return tools');
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
    await waitForResponse(h, 21, 'stale cursor rejection');
    const cachedNames = h.catalog[h.catalog.length - 1].map((tool) => tool.name);
    assert.ok(cachedNames.includes('content-list'));
    assert.ok(cachedNames.includes('media-list'));
  });

  it('removes remote bridge-owned names on every page with filtering enabled or disabled', async () => {
    for (const enabled of [true, false]) {
      const catalog = new ToolCatalog({ toolFilter: enabled
        ? { enabled: true, alwaysIncludeCategories: ['content'] }
        : { enabled: false } });
      const h = makeRecoveryHarness({ catalog, pages: [
        { tools: [
          { name: 'content-list', inputSchema: { type: 'object' } },
          { name: 'wp_bridge_health', inputSchema: { type: 'object' } },
        ], nextCursor: 'page-2' },
        { forCursor: 'page-2', tools: [
          { name: 'content-next', inputSchema: { type: 'object' } },
        ] },
      ] });
      reconnect(h.router, enabled ? 181 : 191, 'siteA');
      await waitForRecovered(h, enabled ? 181 : 191, `reserved-name recovery (${enabled})`);

      // Clear the first recovered-catalog projection, then enumerate a fresh
      // remote sequence exactly as an MCP client does.
      const initial = { jsonrpc: '2.0', id: enabled ? 182 : 192, method: 'tools/list', params: {} };
      h.router.handleClientMessage(initial, JSON.stringify(initial));
      const initialResponse = await waitForResponse(h, initial.id, `initial recovered catalog (${enabled})`);
      assert.ok(initialResponse.result && Array.isArray(initialResponse.result.tools), 'initial recovered catalog must return tools');
      const first = { jsonrpc: '2.0', id: enabled ? 183 : 193, method: 'tools/list', params: {} };
      h.router.handleClientMessage(first, JSON.stringify(first));
      const firstResponse = await waitForResponse(h, first.id, `first remote page (${enabled})`);
      assert.ok(firstResponse.result && Array.isArray(firstResponse.result.tools), 'first remote page must return tools');
      const next = { jsonrpc: '2.0', id: enabled ? 184 : 194, method: 'tools/list', params: { cursor: 'page-2' } };
      h.router.handleClientMessage(next, JSON.stringify(next));
      const nextResponse = await waitForResponse(h, next.id, `second remote page (${enabled})`);
      assert.ok(nextResponse.result && Array.isArray(nextResponse.result.tools), 'second remote page must return tools');

      const aggregate = [firstResponse, nextResponse].flatMap((message) => message.result.tools.map((tool) => tool.name));
      assert.equal(new Set(aggregate).size, aggregate.length, `no duplicate tools when filtering is ${enabled}: ${aggregate.join(', ')}`);
      assert.equal(aggregate.filter((name) => name === 'wp_bridge_health').length, 1, `bridge health appears once when filtering is ${enabled}`);
      assert.ok(aggregate.includes('content-list'));
      assert.ok(aggregate.includes('content-next'));
    }
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
    await waitForRecovered(h, 30);

    const initial = { jsonrpc: '2.0', id: 31, method: 'tools/list', params: {} };
    h.router.handleClientMessage(initial, JSON.stringify(initial));
    const initialResponse = await waitForResponse(h, 31, 'initial filtered catalog');
    assert.ok(initialResponse.result && Array.isArray(initialResponse.result.tools), 'initial filtered catalog must return tools');
    assert.deepEqual(initialResponse.result.tools.map((tool) => tool.name).filter((name) => !name.startsWith('wp_')), ['content-list']);

    // A stale second-page request cannot mutate or duplicate the retained
    // complete catalog.
    const stale = { jsonrpc: '2.0', id: 311, method: 'tools/list', params: { cursor: 'page-2' } };
    h.router.handleClientMessage(stale, JSON.stringify(stale));
    const staleResponse = await waitForResponse(h, 311, 'stale filtered cursor');
    assert.equal(staleResponse.error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), ['content-list', 'media-list']);

    h.router.handleClientMessage({ jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: { name: 'wp_load_tools', arguments: { categories: ['media'] } } }, '{}');
    assert.equal(callResponse(h.sent, 32).result.isError, undefined);
    assert.ok(h.sent.some((message) => message.method === 'notifications/tools/list_changed'));

    const later = { jsonrpc: '2.0', id: 33, method: 'tools/list', params: {} };
    h.router.handleClientMessage(later, JSON.stringify(later));
    const laterResponse = await waitForResponse(h, 33, 'loaded-category first page');
    assert.ok(laterResponse.result && Array.isArray(laterResponse.result.tools), 'loaded-category first page must return tools');
    const pageTwo = { jsonrpc: '2.0', id: 34, method: 'tools/list', params: { cursor: 'page-2' } };
    h.router.handleClientMessage(pageTwo, JSON.stringify(pageTwo));
    const pageTwoResponse = await waitForResponse(h, 34, 'loaded-category second page');
    assert.ok(pageTwoResponse.result && Array.isArray(pageTwoResponse.result.tools), 'loaded-category second page must return tools');
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), ['content-list', 'media-list']);
    const aggregate = [laterResponse, pageTwoResponse].flatMap((message) => message.result.tools.map((tool) => tool.name));
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
    const afterUnloadResponse = await waitForResponse(h, 37, 'unloaded-category first page');
    assert.ok(afterUnloadResponse.result && Array.isArray(afterUnloadResponse.result.tools), 'unloaded-category first page must return tools');
    assert.deepEqual(afterUnloadResponse.result.tools.map((tool) => tool.name).filter((name) => !name.startsWith('wp_')), ['content-list']);
    const afterUnloadPageTwo = { jsonrpc: '2.0', id: 38, method: 'tools/list', params: { cursor: 'page-2' } };
    h.router.handleClientMessage(afterUnloadPageTwo, JSON.stringify(afterUnloadPageTwo));
    const afterUnloadPageTwoResponse = await waitForResponse(h, 38, 'unloaded-category second page');
    assert.ok(afterUnloadPageTwoResponse.result && Array.isArray(afterUnloadPageTwoResponse.result.tools), 'unloaded-category second page must return tools');
    const unloadedAggregate = [afterUnloadResponse, afterUnloadPageTwoResponse].flatMap((message) => message.result.tools.map((tool) => tool.name));
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
    await waitForRecovered(h, 60);
    const initial = { jsonrpc: '2.0', id: 61, method: 'tools/list', params: {} };
    h.router.handleClientMessage(initial, JSON.stringify(initial));
    await waitForResponse(h, 61, 'initial catalog before invalid pages');
    const previous = catalog.fullTools.map((tool) => tool.name);

    config.respond = (request) => request.method === 'tools/list'
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'remote failure' } }
      : undefined;
    const errorPage = { jsonrpc: '2.0', id: 62, method: 'tools/list', params: {} };
    h.router.handleClientMessage(errorPage, JSON.stringify(errorPage));
    const errorResponse = await waitForResponse(h, 62, 'remote error page');
    assert.equal(errorResponse.error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);

    config.respond = (request) => request.method === 'tools/list'
      ? { jsonrpc: '2.0', id: request.id, result: { malformed: true } }
      : undefined;
    const malformed = { jsonrpc: '2.0', id: 63, method: 'tools/list', params: {} };
    h.router.handleClientMessage(malformed, JSON.stringify(malformed));
    const malformedResponse = await waitForResponse(h, 63, 'malformed page');
    assert.equal(malformedResponse.error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);

    // These shapes used to reach sanitizeToolsList() first.  Validate them at
    // the protocol boundary so malformed pages return one client error without
    // throwing or replacing the complete cache.
    config.respond = (request) => request.method === 'tools/list'
      ? { jsonrpc: '2.0', id: request.id, result: { tools: [null] } }
      : undefined;
    const nullTool = { jsonrpc: '2.0', id: 631, method: 'tools/list', params: {} };
    h.router.handleClientMessage(nullTool, JSON.stringify(nullTool));
    const nullToolResponse = await waitForResponse(h, 631, 'null tool page');
    assert.equal(nullToolResponse.error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);

    config.respond = (request) => request.method === 'tools/list'
      ? { jsonrpc: '1.0', id: request.id, result: { tools: [{ name: 'content-wrong-version' }] } }
      : undefined;
    const wrongVersion = { jsonrpc: '2.0', id: 632, method: 'tools/list', params: {} };
    h.router.handleClientMessage(wrongVersion, JSON.stringify(wrongVersion));
    const wrongVersionResponse = await waitForResponse(h, 632, 'wrong-version page');
    assert.equal(wrongVersionResponse.error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);

    config.respond = (request) => {
      if (request.method !== 'tools/list') return undefined;
      return response(request.id, { tools: [{ name: request.params && request.params.cursor ? 'content-next' : 'content-root' }], nextCursor: 'loop' });
    };
    const root = { jsonrpc: '2.0', id: 64, method: 'tools/list', params: {} };
    h.router.handleClientMessage(root, JSON.stringify(root));
    const rootResponse = await waitForResponse(h, 64, 'repeated-cursor first page');
    assert.ok(rootResponse.result && Array.isArray(rootResponse.result.tools), 'repeated-cursor first page must return tools');
    const loop = { jsonrpc: '2.0', id: 65, method: 'tools/list', params: { cursor: 'loop' } };
    h.router.handleClientMessage(loop, JSON.stringify(loop));
    const loopResponse = await waitForResponse(h, 65, 'repeated cursor page');
    assert.equal(loopResponse.error.code, -32603);
    assert.deepEqual(catalog.fullTools.map((tool) => tool.name), previous);
  });

  it('expires a client-owned catalog assembly without allowing its late page to satisfy a reused id', async () => {
    const config = {
      recoveredCatalogAssemblyTimeoutMs: 50,
    };
    const h = makeRecoveryHarness(config);
    reconnect(h.router, 70, 'siteA');
    await waitForRecovered(h, 70);
    config.respond = (request) => {
      if (request.method !== 'tools/list') return undefined;
      if (!request.params || request.params.cursor === undefined) return response(request.id, { tools: [{ name: 'content-root' }], nextCursor: 'late' });
      return null;
    };
    const recoveryRefresh = { jsonrpc: '2.0', id: 710, method: 'tools/list', params: {} };
    h.router.handleClientMessage(recoveryRefresh, JSON.stringify(recoveryRefresh));
    const recoveryRefreshResponse = await waitForResponse(h, 710, 'initial recovered refresh before deadline test');
    assert.ok(recoveryRefreshResponse.result && Array.isArray(recoveryRefreshResponse.result.tools), 'initial recovered refresh must return tools');
    const first = { jsonrpc: '2.0', id: 71, method: 'tools/list', params: {} };
    h.router.handleClientMessage(first, JSON.stringify(first));
    const firstResponse = await waitForResponse(h, 71, 'deadline test first page');
    assert.ok(firstResponse.result && Array.isArray(firstResponse.result.tools), 'deadline test first page must return tools');
    const pending = { jsonrpc: '2.0', id: 72, method: 'tools/list', params: { cursor: 'late' } };
    h.router.handleClientMessage(pending, JSON.stringify(pending));
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(callResponse(h.sent, 72).error.code, -32603);
    h.router.handleClientMessage(pending, JSON.stringify(pending));
    assert.equal(h.requests.filter((entry) => entry.request.id === 72).length, 1, 'id reuse remains blocked until late transport settlement');
    h.transport.onMessage(response(72, { tools: [{ name: 'late-tool' }] }), null);
    assert.equal(h.sent.filter((message) => message.id === 72).length, 2, 'late response is suppressed after the timeout error');
  });

  it('settles a first-page client request exactly once on expiry or supersession', async () => {
    const config = { recoveredCatalogAssemblyTimeoutMs: 50 };
    const h = makeRecoveryHarness(config);
    reconnect(h.router, 74, 'siteA');
    await waitForRecovered(h, 74);
    config.respond = (request) => request.method === 'tools/list' ? null : undefined;

    // The post-recovery projection consumes the one initial request before a
    // client begins a newly assembled remote enumeration.
    config.respond = (request) => request.method === 'tools/list'
      ? response(request.id, { tools: [{ name: 'content-initial' }] })
      : undefined;
    const initial = { jsonrpc: '2.0', id: 741, method: 'tools/list', params: {} };
    h.router.handleClientMessage(initial, JSON.stringify(initial));
    await waitForResponse(h, 741, 'initial recovered refresh before first-page deadline');
    config.respond = (request) => request.method === 'tools/list' ? null : undefined;

    const expired = { jsonrpc: '2.0', id: 75, method: 'tools/list', params: {} };
    h.router.handleClientMessage(expired, JSON.stringify(expired));
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(callResponse(h.sent, 75).error.code, -32603, 'first page receives an expiry response');
    h.transport.onMessage(response(75, { tools: [{ name: 'content-late' }] }), null);
    assert.equal(h.sent.filter((message) => message.id === 75).length, 1, 'late first-page response is suppressed');

    const first = { jsonrpc: '2.0', id: 76, method: 'tools/list', params: {} };
    const replacement = { jsonrpc: '2.0', id: 77, method: 'tools/list', params: {} };
    h.router.handleClientMessage(first, JSON.stringify(first));
    await waitFor(() => h.requests.some((entry) => entry.request.id === 76), 'first page before supersession');
    h.router.handleClientMessage(replacement, JSON.stringify(replacement));
    assert.equal(callResponse(h.sent, 76).error.code, -32603, 'supersession settles the old first page');
    h.transport.onMessage(response(76, { tools: [{ name: 'content-old' }] }), null);
    assert.equal(h.sent.filter((message) => message.id === 76).length, 1, 'superseded first-page response is suppressed');
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(callResponse(h.sent, 77).error.code, -32603, 'replacement first page has its own bounded deadline');
  });

  it('bounds unique endless pages and oversized catalogs before replacing the retained cache', async () => {
    const h = makeRecoveryHarness();
    reconnect(h.router, 73, 'siteA');
    await waitForRecovered(h, 73);
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
    await waitForRecovered(h, 20);
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
