'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { injectSiteParam, extractSiteParam } = require('../lib/tool-injector');

function makeToolsListMsg(tools) {
  return { jsonrpc: '2.0', id: 1, result: { tools } };
}

describe('injectSiteParam', () => {
  it('adds site enum to each tool inputSchema', () => {
    const msg = makeToolsListMsg([
      { name: 'content-list', inputSchema: { type: 'object', properties: { post_type: { type: 'string' } } } },
      { name: 'content-get', inputSchema: { type: 'object', properties: { id: { type: 'number' } } } },
    ]);

    injectSiteParam(msg, ['helena', 'wicked'], 'helena');

    for (const tool of msg.result.tools) {
      assert.ok(tool.inputSchema.properties.site);
      assert.deepEqual(tool.inputSchema.properties.site.enum, ['helena', 'wicked']);
      assert.ok(tool.inputSchema.properties.site.description.includes('helena'));
    }
  });

  it('creates inputSchema if missing', () => {
    const msg = makeToolsListMsg([{ name: 'no-schema' }]);
    injectSiteParam(msg, ['site1'], 'site1');
    assert.ok(msg.result.tools[0].inputSchema.properties.site);
  });

  it('does not add site to required', () => {
    const msg = makeToolsListMsg([
      { name: 'test', inputSchema: { type: 'object', properties: {}, required: ['name'] } },
    ]);
    injectSiteParam(msg, ['s1'], 's1');
    assert.ok(!msg.result.tools[0].inputSchema.required.includes('site'));
  });

  it('returns msg unchanged for non-tools response', () => {
    const msg = { result: { content: [] } };
    const result = injectSiteParam(msg, ['s1'], 's1');
    assert.deepEqual(result, { result: { content: [] } });
  });
});

describe('extractSiteParam', () => {
  it('extracts site and returns clean args', () => {
    const { site, cleanArgs } = extractSiteParam({ site: 'wicked', post_type: 'post' }, 'helena');
    assert.equal(site, 'wicked');
    assert.deepEqual(cleanArgs, { post_type: 'post' });
  });

  it('uses default when site not provided', () => {
    const { site, cleanArgs } = extractSiteParam({ post_type: 'post' }, 'helena');
    assert.equal(site, 'helena');
    assert.deepEqual(cleanArgs, { post_type: 'post' });
  });

  it('handles null/undefined args', () => {
    const { site, cleanArgs } = extractSiteParam(null, 'default');
    assert.equal(site, 'default');
    assert.deepEqual(cleanArgs, {});
  });

  it('handles empty args object', () => {
    const { site, cleanArgs } = extractSiteParam({}, 'default');
    assert.equal(site, 'default');
    assert.deepEqual(cleanArgs, {});
  });
});
