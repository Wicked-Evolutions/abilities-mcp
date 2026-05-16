'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { McpRouter } = require('../lib/router');

/**
 * McpRouter degraded-mode behavior — Issue #76.
 *
 * The gate (verbatim from #76 issue body):
 *   "MCP server boots and responds with valid InitializeResult even when
 *    some/all configured sites have expired refresh tokens; degraded sites
 *    are reported via tools/list, per-call errors, or a dedicated tools/call
 *    shape — not via init failure."
 *
 * When `pool.connectDefault()` returns null (all configured sites failed at
 * boot — see test/connection-pool.test.js #76 describe block), the bootstrap
 * calls `router.enterDegradedMode(degradedSites)` instead of exit(1). The
 * router then:
 *   - synthesizes a valid InitializeResult on `initialize` (echoing the
 *     client's protocolVersion; serverInfo with the bridge package version)
 *   - returns the bridge's three local tools on tools/list
 *   - surfaces a per-call error on non-bridge tools/call naming degraded sites
 *   - bridge tools/call (wp_bridge_health, wp_browse_tools, wp_load_tools)
 *     still work locally — they don't need a backing transport
 *
 * Tests drive the router with a captured-sendToClient callback so the exact
 * wire-shape responses are inspectable.
 */

function makeRouter(opts = {}) {
  const sent = [];
  const router = new McpRouter({
    config: { defaultSite: 'siteA', sites: { siteA: {}, siteB: {} } },
    siteKeys: ['siteA', 'siteB'],
    isMultiSite: true,
    pool: {
      setHandshakeCache() {},
      healthCheck: async () => ({ status: 'unreachable', latencyMs: 1, error: 'degraded' }),
    },
    catalog: {
      isEnabled: () => false,
      cacheTools() {},
      getFilteredTools: () => [],
    },
    sendToClient: (s) => sent.push(s),
    log: () => {},
  });
  if (opts.degraded !== false) {
    router.enterDegradedMode(opts.degradedSites || [
      { siteId: 'siteA', reason: 'Refresh token expired' },
      { siteId: 'siteB', reason: 'Refresh token expired' },
    ]);
  }
  return { router, sent };
}

function parseLast(sent) {
  return JSON.parse(sent[sent.length - 1]);
}

describe('McpRouter — degraded mode (#76)', () => {
  it('synthesizes valid InitializeResult on `initialize` (all three required fields)', () => {
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }, '<line>');

    assert.equal(sent.length, 1);
    const resp = parseLast(sent);
    assert.equal(resp.id, 1);
    assert.ok(resp.result, 'response carries result, not error');
    assert.equal(typeof resp.result.protocolVersion, 'string',
      'protocolVersion present — closes the malformed-InitializeResult symptom');
    assert.equal(resp.result.protocolVersion, '2025-06-18',
      'echoes client protocolVersion per MCP negotiation');
    assert.equal(typeof resp.result.capabilities, 'object',
      'capabilities present');
    assert.equal(typeof resp.result.serverInfo, 'object',
      'serverInfo present');
    assert.equal(typeof resp.result.serverInfo.name, 'string');
    assert.equal(typeof resp.result.serverInfo.version, 'string');
  });

  it('synthesized InitializeResult defaults protocolVersion when client omits it', () => {
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { capabilities: {} },
    }, '<line>');

    const resp = parseLast(sent);
    assert.equal(typeof resp.result.protocolVersion, 'string');
    assert.ok(resp.result.protocolVersion.length > 0);
  });

  it('tools/list returns the three bridge tools only', () => {
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    }, '<line>');

    const resp = parseLast(sent);
    assert.ok(resp.result, 'tools/list returns result, not error');
    assert.ok(Array.isArray(resp.result.tools));
    const names = resp.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['wp_bridge_health', 'wp_browse_tools', 'wp_load_tools'],
      'degraded-mode tools/list = bridge tools only (no WordPress-side tools)');
  });

  it('non-bridge tools/call surfaces per-call error naming degraded sites', () => {
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'content-list', arguments: {} },
    }, '<line>');

    const resp = parseLast(sent);
    assert.ok(resp.error, 'non-bridge tool call returns error in degraded mode');
    assert.equal(resp.id, 3);
    assert.match(resp.error.message, /degraded/i,
      'error message names degraded mode for operator clarity');
    assert.match(resp.error.message, /siteA/);
    assert.match(resp.error.message, /siteB/);
    assert.match(resp.error.message, /reauth/i,
      'error message names the recovery path');
  });

  it('bridge tools/call (wp_bridge_health) still works in degraded mode — diagnostics path stays open', async () => {
    // wp_bridge_health is the operator's diagnostic tool; it MUST be callable
    // even when every WordPress site is degraded so operators can see which
    // sites are degraded and pick a reauth target.
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'wp_bridge_health', arguments: {} },
    }, '<line>');

    // wp_bridge_health calls pool.healthCheck per site — async; await tick.
    await new Promise((r) => setImmediate(r));

    const resp = parseLast(sent);
    assert.ok(resp.result, 'bridge tool call returns result, not error');
    assert.ok(resp.result.content, 'wp_bridge_health emits content');
  });

  it('non-degraded mode (regression) — initialize forwards to defaultTransport, no synthesis', () => {
    const sent = [];
    const transportSends = [];
    const router = new McpRouter({
      config: { defaultSite: 'siteA', sites: { siteA: {} } },
      siteKeys: ['siteA'],
      isMultiSite: false,
      pool: { setHandshakeCache() {} },
      catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
      sendToClient: (s) => sent.push(s),
      log: () => {},
    });
    router.setDefaultTransport({ send: (line) => transportSends.push(line) });

    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    }, '<line>');

    assert.equal(sent.length, 0,
      'non-degraded path does NOT synthesize a response — forwards to transport');
    assert.equal(transportSends.length, 1,
      'forwarded line reaches the default transport unchanged');
  });

  it('request-time boundary (#87 S1/S2) — default-site initialize failure falls back to a healthy site, bridge NOT degraded', async () => {
    // Issue #87 S1: the #82 follow-up made a single default-site request-time
    // refresh failure flip the WHOLE router to degraded (and it never
    // recovered — S2). Correct behavior mirrors the boot path: try a healthy
    // fallback site, re-forward the cached initialize through it, stay healthy.
    const sent = [];
    const fallbackTransport = { send: (l) => sent.push(`[fallback-tx]${l}`) };
    let connectFallbackArgs = null;
    const router = new McpRouter({
      config: { defaultSite: 'wickedevolutions', sites: { wickedevolutions: {}, helenawillow: {} } },
      siteKeys: ['wickedevolutions', 'helenawillow'],
      isMultiSite: true,
      pool: {
        setHandshakeCache() {},
        async connectFallback(excludeSiteIds) {
          connectFallbackArgs = excludeSiteIds;
          this._cfg.defaultSite = 'helenawillow'; // pool promotes runtime default
          return fallbackTransport;
        },
        _cfg: null,
      },
      catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
      sendToClient: (s) => sent.push(s),
      log: () => {},
    });
    router.pool._cfg = router.config; // pool mutates config.defaultSite like the real pool
    router.setDefaultTransport({ send: () => {} });

    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }));

    router.handleTransportMessage({
      jsonrpc: '2.0', id: 1,
      error: { code: -32000, message: 'OAuth HTTP bridge error: Refresh token expired for site "wickedevolutions"' },
    }, null);

    await router._initFailurePromise; // deterministic: await the fallback

    assert.deepEqual(connectFallbackArgs, ['wickedevolutions'], 'pool.connectFallback invoked with the accumulated exclude set (failed default site)');
    assert.equal(router.degraded, false, 'S1: bridge stays healthy — single default-site failure does NOT degrade the whole router');
    assert.equal(router.config.defaultSite, 'helenawillow', 'runtime default promoted to the healthy fallback site');
    // Cached initialize re-forwarded through the fallback transport (so the
    // client gets a real InitializeResult and the catalog populates normally
    // — S2: no stale/empty per-session catalog).
    assert.ok(
      sent.some((s) => s.startsWith('[fallback-tx]') && s.includes('"method":"initialize"')),
      'S2: cached initialize re-forwarded via the healthy fallback transport'
    );
    // No synthesized degraded InitializeResult was emitted to the client.
    assert.ok(
      !sent.some((s) => { try { const m = JSON.parse(s); return m.result && m.result.serverInfo && /degraded/.test(m.result.serverInfo.name); } catch { return false; } }),
      'no synthesized "(degraded)" InitializeResult — the real one comes from the fallback site'
    );
  });

  it('regression guard (#76 / #87) — when ALL sites fail (no fallback) the bridge still synthesizes InitializeResult + enters degraded mode', async () => {
    // The #76 gate must still hold: genuine all-sites-down must NOT kill init.
    // Single-site config → connectFallback has nothing to fall back to → null.
    const sent = [];
    const router = new McpRouter({
      config: { defaultSite: 'wicked-community', sites: { 'wicked-community': {} } },
      siteKeys: ['wicked-community'],
      isMultiSite: false,
      pool: {
        setHandshakeCache() {},
        async connectFallback() { return null; }, // no other site can serve
      },
      catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
      sendToClient: (s) => sent.push(s),
      log: () => {},
    });
    router.setDefaultTransport({ send: () => {} });

    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }, '<line>');

    router.handleTransportMessage({
      jsonrpc: '2.0', id: 1,
      error: {
        code: -32000,
        message: 'OAuth HTTP bridge error: OAuth refresh failed: ' +
          'Refresh token expired for site "wicked-community". ' +
          'Run: abilities-mcp reauth wicked-community',
      },
    }, null);

    await router._initFailurePromise;

    const last = JSON.parse(sent[sent.length - 1]);
    assert.equal(last.id, 1);
    assert.ok(last.result, 'response carries result, not error');
    assert.equal(last.result.protocolVersion, '2025-06-18', 'echoes client protocolVersion');
    assert.equal(typeof last.result.capabilities, 'object', 'capabilities present');
    assert.equal(typeof last.result.serverInfo, 'object', 'serverInfo present');
    assert.equal(last.result.content, undefined, 'not CallToolResult shape');
    assert.equal(last.result.isError, undefined, 'not CallToolResult shape');

    assert.equal(router.degraded, true, 'all-sites-down → degraded mode (the #76 gate still fires)');
    assert.equal(router.degradedSites.length, 1);
    assert.equal(router.degradedSites[0].siteId, 'wicked-community');
    assert.match(router.degradedSites[0].reason, /Refresh token expired/);
  });

  it('convergence guard (#87 PR#88 reviewer blocker) — two OAuth-like sites that connect OK but both fail the re-forwarded initialize MUST converge to synthesized InitializeResult + degraded mode (no infinite alternation)', async () => {
    // OAuth transport.connect() does NOT validate refresh tokens, so a
    // freshly-connected fallback can itself fail the re-forwarded initialize.
    // Without an accumulated exclude set the router alternates siteA→siteB→
    // siteA… forever, degraded never fires, the #76 gate never holds. The
    // router must track every site that failed the cached initialize and
    // degrade once the candidate pool is exhausted.
    const sent = [];
    const config = { defaultSite: 'siteA', sites: { siteA: {}, siteB: {} } };

    // A transport that "connected" (no token validation) but fails the
    // re-forwarded cached initialize — emits an error carrying the cached
    // initialize id, naming whatever site is currently the runtime default.
    const badTransport = () => ({
      send() {
        queueMicrotask(() => router.handleTransportMessage({
          jsonrpc: '2.0', id: 1,
          error: { code: -32000, message: `Refresh token expired for site "${config.defaultSite}"` },
        }, null));
      },
    });

    const connectFallbackExcludes = [];
    const router = new McpRouter({
      config,
      siteKeys: ['siteA', 'siteB'],
      isMultiSite: true,
      pool: {
        setHandshakeCache() {},
        async connectFallback(excludeSiteIds) {
          connectFallbackExcludes.push([...excludeSiteIds]);
          const ex = new Set(excludeSiteIds);
          const next = ['siteA', 'siteB'].find((s) => !ex.has(s));
          if (!next) return null;            // pool exhausted → caller degrades
          config.defaultSite = next;          // pool promotes runtime default
          return badTransport();              // connects, but will fail init too
        },
      },
      catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
      sendToClient: (s) => sent.push(s),
      log: () => {},
    });
    router.setDefaultTransport(badTransport());

    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));

    // Pump microtasks until convergence, capped well below "forever" — if the
    // alternation bug were present this cap would trip before router.degraded.
    for (let i = 0; i < 20 && !router.degraded; i++) {
      await new Promise((r) => setImmediate(r));
    }

    assert.equal(router.degraded, true,
      'converged: every site failed the cached initialize → #76 all-sites-down gate fired (no infinite alternation)');
    // The exclude set must have strictly grown ([] → [siteA] → [siteA,siteB]).
    const lastExclude = connectFallbackExcludes[connectFallbackExcludes.length - 1];
    assert.deepEqual([...lastExclude].sort(), ['siteA', 'siteB'],
      'router accumulated BOTH failed sites before degrading');
    assert.ok(connectFallbackExcludes.length <= 3,
      `bounded number of fallback attempts (got ${connectFallbackExcludes.length}) — strictly converging, not alternating`);

    const last = JSON.parse(sent[sent.length - 1]);
    assert.equal(last.id, 1);
    assert.equal(last.result.protocolVersion, '2025-06-18', 'synthesized InitializeResult (the #76 gate)');
    assert.equal(typeof last.result.serverInfo, 'object');
    assert.equal(last.result.content, undefined, 'not CallToolResult shape');

    const degradedIds = router.degradedSites.map((s) => s.siteId).sort();
    assert.deepEqual(degradedIds, ['siteA', 'siteB'], 'both sites reported degraded');
    for (const ds of router.degradedSites) {
      assert.match(ds.reason, /Refresh token expired/, `per-site initialize-failure reason recorded for ${ds.siteId}`);
    }
  });

  it('request-time boundary (#76 follow-up) — non-initialize error responses still convert to CallToolResult (regression)', () => {
    // The intercept must ONLY fire for the cached initialize id. Other
    // request errors (e.g. tools/call) must keep the existing CallToolResult
    // conversion behavior — that's how MCP clients learn about per-call
    // errors today.
    const sent = [];
    const router = new McpRouter({
      config: { defaultSite: 'siteA', sites: { siteA: {} } },
      siteKeys: ['siteA'],
      isMultiSite: false,
      pool: { setHandshakeCache() {} },
      catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
      sendToClient: (s) => sent.push(s),
      log: () => {},
    });
    router.setDefaultTransport({ send: () => {} });

    // Cache an initialize at id=1
    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    }, '<line>');

    sent.length = 0;  // reset

    // Transport emits an error for id=42 (some tools/call) — NOT the cached
    // initialize id. Existing conversion semantics must still apply.
    router.handleTransportMessage({
      jsonrpc: '2.0', id: 42,
      error: { code: -32603, message: 'tool failed' },
    }, null);

    assert.equal(sent.length, 1);
    const last = JSON.parse(sent[0]);
    assert.equal(last.id, 42);
    assert.ok(last.result, 'tools-call error converts to CallToolResult shape');
    assert.equal(last.result.isError, true);
    assert.ok(Array.isArray(last.result.content));
    assert.match(last.result.content[0].text, /tool failed/);

    // Router must NOT have entered degraded mode for an unrelated tool error.
    assert.equal(router.degraded, false);
  });

  it('enterDegradedMode is reentrant — second call refreshes the degraded-sites list', () => {
    const { router, sent } = makeRouter();
    router.enterDegradedMode([{ siteId: 'newsite', reason: 'recheck' }]);

    router.handleClientMessage({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'content-list' },
    }, '<line>');

    const resp = parseLast(sent);
    assert.match(resp.error.message, /newsite/);
    assert.doesNotMatch(resp.error.message, /siteA/);
  });
});
