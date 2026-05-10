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
