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
              const cursor = request.params && request.params.cursor;
              const page = cursor === undefined ? pages[0] : pages.find((p) => p.forCursor === cursor);
              this.onMessage(response(request.id, page || { tools: [] }), null);
            }
          }, delay);
        },
      };
      return transport;
    },
    promoteStagedTransport(site, staged) { promoted.push({ site, staged }); },
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

  it('does not suppress a normal response that reuses a former private recovery id', async () => {
    const h = makeRecoveryHarness();
    reconnect(h.router, 20, 'siteA');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const privateId = h.requests.find((entry) => entry.request.method === 'initialize').request.id;
    h.transport.onMessage(response(privateId, { content: [{ type: 'text', text: 'ordinary collision' }] }), null);
    assert.equal(callResponse(h.sent, privateId).result.content[0].text, 'ordinary collision');
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
