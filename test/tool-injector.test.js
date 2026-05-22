'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  injectSiteParam,
  extractSiteParam,
  applyAdapterToolSchemaOverlays,
  ADAPTER_TOOL_SCHEMA_OVERLAYS,
} = require('../lib/tool-injector');

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

describe('applyAdapterToolSchemaOverlays — mcp-adapter-discover-abilities (#97)', () => {
  it('advertises the six adapter filter params on mcp-adapter-discover-abilities when the projected schema is empty', () => {
    const msg = makeToolsListMsg([
      { name: 'mcp-adapter-discover-abilities', inputSchema: { type: 'object' } },
    ]);

    applyAdapterToolSchemaOverlays(msg);

    const props = msg.result.tools[0].inputSchema.properties;
    assert.ok(props, 'properties created');
    for (const key of ['category', 'annotation', 'search', 'compact', 'limit', 'offset']) {
      assert.ok(props[key], `missing property: ${key}`);
    }
    assert.equal(props.category.type, 'string');
    assert.equal(props.annotation.type, 'string');
    assert.deepEqual(props.annotation.enum, ['readonly', 'destructive']);
    assert.equal(props.search.type, 'string');
    assert.equal(props.compact.type, 'boolean');
    assert.equal(props.limit.type, 'integer');
    assert.equal(props.limit.minimum, 0);
    assert.equal(props.limit.maximum, 200);
    assert.equal(props.offset.type, 'integer');
    assert.equal(props.offset.minimum, 0);
  });

  it('site can still be injected after the overlay (compose cleanly)', () => {
    const msg = makeToolsListMsg([
      { name: 'mcp-adapter-discover-abilities', inputSchema: { type: 'object' } },
    ]);

    applyAdapterToolSchemaOverlays(msg);
    injectSiteParam(msg, ['dev2', 'helena'], 'dev2');

    const props = msg.result.tools[0].inputSchema.properties;
    for (const key of ['site', 'category', 'annotation', 'search', 'compact', 'limit', 'offset']) {
      assert.ok(props[key], `missing property after composition: ${key}`);
    }
  });

  it('does not require any property — the param-less call shape stays valid', () => {
    const msg = makeToolsListMsg([
      { name: 'mcp-adapter-discover-abilities', inputSchema: { type: 'object' } },
    ]);
    applyAdapterToolSchemaOverlays(msg);
    const schema = msg.result.tools[0].inputSchema;
    // Either there is no `required` array, or it is empty.
    if (Array.isArray(schema.required)) {
      assert.equal(schema.required.length, 0, 'no overlay property should be required');
    }
  });

  it('adapter projection wins over overlay on collisions — bridge does not override adapter intent', () => {
    const adapterCategory = {
      type: 'string',
      description: 'ADAPTER-AUTHORITATIVE DESCRIPTION',
      // Hypothetical future adapter rename / tightening — bridge must not stomp it.
      pattern: '^[a-z][a-z0-9-]*$',
    };
    const msg = makeToolsListMsg([
      {
        name: 'mcp-adapter-discover-abilities',
        inputSchema: {
          type: 'object',
          properties: { category: adapterCategory },
        },
      },
    ]);

    applyAdapterToolSchemaOverlays(msg);

    const projectedCategory = msg.result.tools[0].inputSchema.properties.category;
    assert.equal(projectedCategory, adapterCategory, 'adapter-supplied property is preserved by reference');
    assert.equal(projectedCategory.description, 'ADAPTER-AUTHORITATIVE DESCRIPTION');
    assert.equal(projectedCategory.pattern, '^[a-z][a-z0-9-]*$');
    // The remaining 5 overlay params are still added.
    for (const key of ['annotation', 'search', 'compact', 'limit', 'offset']) {
      assert.ok(msg.result.tools[0].inputSchema.properties[key], `missing complementary property: ${key}`);
    }
  });

  it('only applies to known tool names — other tools are untouched', () => {
    const msg = makeToolsListMsg([
      { name: 'mcp-adapter-execute-ability', inputSchema: { type: 'object', properties: { ability_name: { type: 'string' } } } },
      { name: 'content-list', inputSchema: { type: 'object', properties: { post_type: { type: 'string' } } } },
    ]);

    applyAdapterToolSchemaOverlays(msg);

    assert.deepEqual(
      Object.keys(msg.result.tools[0].inputSchema.properties),
      ['ability_name'],
      'mcp-adapter-execute-ability not in overlay map — schema unchanged',
    );
    assert.deepEqual(
      Object.keys(msg.result.tools[1].inputSchema.properties),
      ['post_type'],
      'unrelated tool schema untouched',
    );
  });

  it('is a no-op when msg has no tools array', () => {
    const empty = { jsonrpc: '2.0', id: 1, result: {} };
    const result = applyAdapterToolSchemaOverlays(empty);
    assert.equal(result, empty);
  });

  it('repairs a malformed inputSchema (array or non-object) into a valid object before overlay', () => {
    const msg = makeToolsListMsg([
      { name: 'mcp-adapter-discover-abilities', inputSchema: [] },
    ]);
    applyAdapterToolSchemaOverlays(msg);
    const schema = msg.result.tools[0].inputSchema;
    assert.equal(schema.type, 'object');
    assert.equal(typeof schema.properties, 'object');
    assert.ok(!Array.isArray(schema.properties));
    assert.ok(schema.properties.compact, 'overlay applied after repair');
  });
});

describe('ADAPTER_TOOL_SCHEMA_OVERLAYS — sanity', () => {
  it('discover-abilities overlay names match the adapter source exactly', () => {
    // Mirror of src/Abilities/DiscoverAbilitiesAbility.php input_schema property
    // names. If the adapter renames or drops one of these the bridge overlay
    // must follow — the parity is the contract this test pins.
    const overlay = ADAPTER_TOOL_SCHEMA_OVERLAYS['mcp-adapter-discover-abilities'];
    assert.ok(overlay);
    assert.deepEqual(
      Object.keys(overlay.properties).sort(),
      ['annotation', 'category', 'compact', 'limit', 'offset', 'search'],
    );
  });
});
