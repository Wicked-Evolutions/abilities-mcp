'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { McpRouter } = require('../lib/router');
const { ToolCatalog } = require('../lib/tool-catalog');

/**
 * McpRouter — bridge orientation (Issue #85).
 *
 * Pins:
 *   1. wp_browse_tools response describes itself as the direct-tool catalog
 *      scoped to defaultSite and points cross-site callers at the
 *      mcp-adapter-* meta-tools.
 *   2. wp_load_tools(["unknown-category"]) returns a structured pointer to
 *      the adapter meta-tools instead of silently activating zero categories.
 *
 * The tools/list-time always-include behavior is covered in
 * test/tool-catalog.test.js (#85-bridge-orientation describe block).
 */

const FULL_TOOLS = [
  { name: 'content-list' },
  { name: 'content-get' },
  { name: 'media-list' },
  { name: 'mcp-adapter-discover-abilities' },
  { name: 'mcp-adapter-get-ability-info' },
  { name: 'mcp-adapter-execute-ability' },
];

function makeRouter({ filterEnabled = true, primeCatalog = true } = {}) {
  const sent = [];
  const config = {
    defaultSite: 'wickedevolutions',
    sites: { wickedevolutions: {}, helenawillow: {} },
    toolFilter: filterEnabled ? { enabled: true } : { enabled: false },
  };
  const catalog = new ToolCatalog(config);
  if (primeCatalog) catalog.cacheTools(FULL_TOOLS);

  const router = new McpRouter({
    config,
    siteKeys: ['wickedevolutions', 'helenawillow'],
    isMultiSite: true,
    pool: { setHandshakeCache() {} },
    catalog,
    sendToClient: (s) => sent.push(s),
    log: () => {},
  });
  return { router, sent, catalog };
}

function parseLast(sent) {
  return JSON.parse(sent[sent.length - 1]);
}

// wp_load_tools may emit a trailing notifications/tools/list_changed when
// activated.length > 0; grab the response carrying the request id instead.
function parseResponse(sent, id) {
  for (const raw of sent) {
    const parsed = JSON.parse(raw);
    if (parsed.id === id) return parsed;
  }
  throw new Error(`no response found for id ${id}`);
}

describe('McpRouter — wp_browse_tools orientation (#85)', () => {
  it('response includes the adapter-meta-tool pointer and names defaultSite scope', () => {
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'wp_browse_tools', arguments: {} },
    }, '<line>');

    const resp = parseLast(sent);
    const text = resp.result.content[0].text;

    assert.match(text, /direct-tool catalog/i,
      'response self-describes as the direct-tool catalog');
    assert.match(text, /scoped to defaultSite/i);
    assert.match(text, /wickedevolutions/,
      'response names the actual defaultSite for operator clarity');
    assert.match(text, /mcp-adapter-discover-abilities/);
    assert.match(text, /mcp-adapter-execute-ability/);
    assert.match(text, /\{ site, category \}/);
    assert.match(text, /\{ site, ability_name, parameters \}/);
  });
});

describe('McpRouter — wp_load_tools missing-category pointer (#85)', () => {
  it('unknown category returns the structured pointer (not silent zero-activation)', () => {
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'wp_load_tools', arguments: { categories: ['surecart-ecommerce'] } },
    }, '<line>');

    const resp = parseLast(sent);
    const text = resp.result.content[0].text;

    assert.match(text, /surecart-ecommerce/,
      'response names the missing category back to the caller');
    assert.match(text, /not in the direct-tool catalog/i,
      'response is explicit about why the category was not activated');
    assert.match(text, /mcp-adapter-discover-abilities/);
    assert.match(text, /mcp-adapter-execute-ability/);
    assert.match(text, /\{ site: "<site>", category: "surecart-ecommerce" \}/,
      'pointer is parameterized with the actual missing category name');
    assert.doesNotMatch(text, /No changes — categories may already be active/,
      'no longer falls into the silent "may already be active" branch');
  });

  it('mixed request (one known + one unknown) activates the known and points for the unknown', () => {
    const { router, sent } = makeRouter();
    router.handleClientMessage({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'wp_load_tools', arguments: { categories: ['content', 'spectra'] } },
    }, '<line>');

    const resp = parseResponse(sent, 3);
    const text = resp.result.content[0].text;

    assert.match(text, /Activated: content/);
    assert.match(text, /not in the direct-tool catalog/i);
    assert.match(text, /spectra/);
    assert.match(text, /mcp-adapter-discover-abilities/);
  });
});
