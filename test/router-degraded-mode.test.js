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

  it('request-time boundary (#76 follow-up) — initialize forward error → synthesized InitializeResult, NOT CallToolResult', () => {
    // Operator reproduction (paste from PR-side captured evidence):
    //   {"jsonrpc":"2.0","id":1,"result":{
    //     "content":[{"type":"text","text":"[-32000] OAuth HTTP bridge error: ..."}],
    //     "isError":true
    //   }}
    //
    // This shape is CallToolResult, not InitializeResult — MCP SDK rejects it.
    // The router must intercept error responses whose id matches the cached
    // initialize and synthesize a valid InitializeResult locally before the
    // generic JSON-RPC-error→CallToolResult conversion at the bottom of
    // handleTransportMessage runs.
    const sent = [];
    const router = new McpRouter({
      config: { defaultSite: 'wicked-community', sites: { 'wicked-community': {} } },
      siteKeys: ['wicked-community'],
      isMultiSite: false,
      pool: { setHandshakeCache() {} },
      catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
      sendToClient: (s) => sent.push(s),
      log: () => {},
    });
    router.setDefaultTransport({ send: () => {} });

    // 1. Client sends initialize — gets cached + forwarded.
    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    }, '<line>');

    // 2. Transport emits the operator-reproduced error response shape:
    //    error response with id matching the cached initialize id.
    router.handleTransportMessage({
      jsonrpc: '2.0', id: 1,
      error: {
        code: -32000,
        message: 'OAuth HTTP bridge error: OAuth refresh failed: ' +
          'Refresh token expired for site "wicked-community". ' +
          'Run: abilities-mcp reauth wicked-community',
      },
    }, null);

    // 3. Client must see InitializeResult shape — NOT the CallToolResult shape
    //    that motivated this PR.
    assert.ok(sent.length >= 1, 'router must emit a response to the client');
    const last = JSON.parse(sent[sent.length - 1]);
    assert.equal(last.id, 1);
    assert.ok(last.result, 'response carries result, not error');
    assert.equal(typeof last.result.protocolVersion, 'string',
      'protocolVersion present — InitializeResult shape, not CallToolResult');
    assert.equal(last.result.protocolVersion, '2025-06-18',
      'echoes client protocolVersion per MCP negotiation');
    assert.equal(typeof last.result.capabilities, 'object',
      'capabilities object present');
    assert.equal(typeof last.result.serverInfo, 'object',
      'serverInfo object present');

    // The CallToolResult-shape fields MUST NOT be present on the synthesized
    // initialize response — they are how the MCP runtime detected the bug.
    assert.equal(last.result.content, undefined,
      'no content[] — that is CallToolResult shape, the gate-violating shape');
    assert.equal(last.result.isError, undefined,
      'no isError — that is CallToolResult shape, the gate-violating shape');

    // 4. Bridge must enter degraded mode so subsequent tool calls behave
    //    correctly and wp_bridge_health surfaces the failure.
    assert.equal(router.degraded, true,
      'router must enter degraded mode on initialize failure');
    assert.equal(router.degradedSites.length, 1);
    assert.equal(router.degradedSites[0].siteId, 'wicked-community');
    assert.match(router.degradedSites[0].reason, /Refresh token expired/);
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
