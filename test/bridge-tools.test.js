'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { BRIDGE_TOOLS, isBridgeTool, injectBridgeTools } = require('../lib/bridge-tools');

describe('BRIDGE_TOOLS', () => {
  it('contains exactly 3 bridge tools', () => {
    assert.equal(BRIDGE_TOOLS.length, 3);
  });

  it('has wp_bridge_health, wp_browse_tools, wp_load_tools', () => {
    const names = BRIDGE_TOOLS.map(t => t.name);
    assert.ok(names.includes('wp_bridge_health'));
    assert.ok(names.includes('wp_browse_tools'));
    assert.ok(names.includes('wp_load_tools'));
  });

  it('all tools have name, description, and inputSchema', () => {
    for (const tool of BRIDGE_TOOLS) {
      assert.ok(tool.name);
      assert.ok(tool.description);
      assert.ok(tool.inputSchema);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });
});

describe('isBridgeTool', () => {
  it('returns true for bridge tool names', () => {
    assert.equal(isBridgeTool('wp_bridge_health'), true);
    assert.equal(isBridgeTool('wp_browse_tools'), true);
    assert.equal(isBridgeTool('wp_load_tools'), true);
  });

  it('returns false for WordPress tools', () => {
    assert.equal(isBridgeTool('content-list'), false);
    assert.equal(isBridgeTool('fluent-crm-list-contacts'), false);
    assert.equal(isBridgeTool(''), false);
  });
});

describe('injectBridgeTools', () => {
  it('appends bridge tools to tools array', () => {
    const msg = { result: { tools: [{ name: 'content-list' }] } };
    injectBridgeTools(msg);
    assert.equal(msg.result.tools.length, 4); // 1 original + 3 bridge
    assert.equal(msg.result.tools[0].name, 'content-list');
    assert.equal(msg.result.tools[1].name, 'wp_bridge_health');
  });

  it('handles empty tools array', () => {
    const msg = { result: { tools: [] } };
    injectBridgeTools(msg);
    assert.equal(msg.result.tools.length, 3);
  });

  it('does nothing for non-tools response', () => {
    const msg = { result: { content: [] } };
    injectBridgeTools(msg);
    assert.equal(msg.result.content.length, 0);
  });
});
