#!/usr/bin/env node
'use strict';

/**
 * Fix-proof harness for issue #87 — the post-recent-dev bridge regression set.
 *
 * Same three symptoms as the original reproduction, driven against the bridge's
 * own units (McpRouter) and the adapter's default-server config — offline,
 * deterministic, NOT via the Claude Code MCP tool path (the broken thing).
 *
 * Pre-fix this harness reported "3/3 REPRODUCED" (defects present). Post-fix it
 * asserts the corrected behavior:
 *
 *   S1  A single (default) site's request-time refresh failure no longer
 *       blanket-degrades the bridge: the router falls back to a healthy site
 *       and a tools/call targeting that healthy site is served, not -32603.
 *   S2  The single-site failure path no longer goes sticky-degraded: the
 *       cached initialize is re-forwarded through the fallback transport so
 *       the catalog populates normally (no per-session stale/empty catalog).
 *   S3  mcp-adapter/get-started is now in the default server's `tools`
 *       allowlist, matching the advertised boot_sequence.first_tool.
 *
 * Run: node test/manual/repro-87.js
 * Exit 0 = all three fixes proven.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { McpRouter } = require('../../lib/router.js');

async function symptom1() {
  const sent = [];
  const fallbackTx = { send: (l) => sent.push(`[fallback-tx]${l}`) };
  const config = { defaultSite: 'wickedevolutions', sites: { wickedevolutions: {}, helenawillow: {} } };
  const router = new McpRouter({
    config,
    siteKeys: ['wickedevolutions', 'helenawillow'],
    isMultiSite: true,
    pool: {
      setHandshakeCache() {},
      async connectFallback(failedSiteId) {
        assert.equal(failedSiteId, 'wickedevolutions');
        config.defaultSite = 'helenawillow';
        return fallbackTx;
      },
      async getTransport(site) {
        return { onMessage: null, send: () => sent.push(`[routed-to:${site}]`) };
      },
    },
    catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
    sendToClient: (s) => sent.push(s),
    log: () => {},
  });
  router.setDefaultTransport({ send() {} });

  const initLine = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  router.handleClientMessage(JSON.parse(initLine), initLine);
  router.handleTransportMessage(
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Refresh token expired for site "wickedevolutions"' } },
    null
  );
  await router._initFailurePromise;

  assert.equal(router.degraded, false, 'S1: bridge NOT degraded after single default-site failure');
  assert.equal(config.defaultSite, 'helenawillow', 'S1: runtime default promoted to healthy site');

  sent.length = 0;
  const callLine = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mcp-adapter-execute-ability', arguments: { site: 'helenawillow', ability_name: 'core/get-site-info' } } });
  router.handleClientMessage(JSON.parse(callLine), callLine);
  assert.ok(
    !sent.some((s) => { try { const m = JSON.parse(s); return m.error && m.error.code === -32603 && /degraded/i.test(m.error.message); } catch { return false; } }),
    'S1: healthy-site tools/call is NOT refused with -32603 degraded'
  );
  assert.ok(sent.some((s) => s.startsWith('[fallback-tx]')), 'S1: call routed to the healthy default transport');
  console.log('S1 FIXED: one default-site refresh expiry → fallback to healthy site; bridge stays healthy; healthy-site tools/call served (no -32603 blast radius).');
}

async function symptom2() {
  const sent = [];
  const fallbackTx = { send: (l) => sent.push(`[fallback-tx]${l}`) };
  const config = { defaultSite: 'wickedevolutions', sites: { wickedevolutions: {}, helenawillow: {} } };
  const router = new McpRouter({
    config,
    siteKeys: ['wickedevolutions', 'helenawillow'],
    isMultiSite: true,
    pool: {
      setHandshakeCache() {},
      async connectFallback() { config.defaultSite = 'helenawillow'; return fallbackTx; },
    },
    catalog: { isEnabled: () => false, cacheTools() {}, getFilteredTools: () => [] },
    sendToClient: (s) => sent.push(s),
    log: () => {},
  });
  router.setDefaultTransport({ send() {} });

  const initLine = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  router.handleClientMessage(JSON.parse(initLine), initLine);
  router.handleTransportMessage(
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Refresh token expired for site "wickedevolutions"' } },
    null
  );
  await router._initFailurePromise;

  assert.equal(router.degraded, false, 'S2: router did NOT go sticky-degraded on the single-site path');
  assert.ok(
    sent.some((s) => s.startsWith('[fallback-tx]') && s.includes('"method":"initialize"')),
    'S2: cached initialize re-forwarded through the healthy fallback transport'
  );
  console.log('S2 FIXED: single-site failure path falls back instead of sticky-degrading; cached initialize re-forwarded via healthy transport → catalog populates normally.');
}

function symptom3() {
  const factory = fs.readFileSync(
    path.join(__dirname, '../../../abilities-mcp-adapter/src/Servers/DefaultServerFactory.php'),
    'utf8'
  );
  const advertised = factory.match(/"first_tool":"([^"]+)"/)[1];
  const toolsBlock = factory.match(/'tools'\s*=>\s*array\(([\s\S]*?)\n\s*\),/);
  const registeredTools = [...toolsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(
    registeredTools.includes(advertised),
    `S3: advertised boot tool "${advertised}" must be in the server tools allowlist [${registeredTools.join(', ')}]`
  );
  console.log(`S3 FIXED: boot_sequence advertises "${advertised}" and it is now in the default server tools allowlist → dispatch resolves (no -32003).`);
}

(async () => {
  let passed = 0;
  await symptom1(); passed++;
  await symptom2(); passed++;
  symptom3(); passed++;
  console.log(`\n#87 fix-proof: ${passed}/3 symptoms corrected (bridge units + adapter config; not the MCP path).`);
  process.exit(passed === 3 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
