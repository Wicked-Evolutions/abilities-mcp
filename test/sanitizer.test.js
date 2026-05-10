'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeToolsList, isToolsListResponse } = require('../lib/sanitizer');

// Helper: build a tools/list response message
function makeToolsListMsg(tools) {
  return { jsonrpc: '2.0', id: 1, result: { tools } };
}

// Helper: build a tool with common fields
function makeTool(overrides = {}) {
  return {
    name: 'content-list',
    description: 'List content',
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  };
}

describe('isToolsListResponse', () => {
  it('returns true for valid tools/list response', () => {
    const msg = makeToolsListMsg([makeTool()]);
    assert.equal(isToolsListResponse(msg), true);
  });

  it('returns false for non-tools response', () => {
    assert.equal(isToolsListResponse({ result: { content: [] } }), false);
    assert.equal(isToolsListResponse({ error: {} }), false);
    assert.equal(isToolsListResponse({}), false);
  });
});

describe('sanitizeToolsList — field stripping', () => {
  it('removes type and outputSchema', () => {
    const msg = makeToolsListMsg([makeTool({
      type: 'action',
      outputSchema: { type: 'object' },
    })]);

    sanitizeToolsList(msg);

    assert.equal(msg.result.tools[0].type, undefined);
    assert.equal(msg.result.tools[0].outputSchema, undefined);
  });

  it('preserves name, description, and inputSchema', () => {
    const msg = makeToolsListMsg([makeTool()]);
    sanitizeToolsList(msg);

    const tool = msg.result.tools[0];
    assert.equal(tool.name, 'content-list');
    assert.equal(tool.description, 'List content');
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
  });

  it('handles empty tools array', () => {
    const msg = makeToolsListMsg([]);
    sanitizeToolsList(msg);
    assert.deepEqual(msg.result.tools, []);
  });

  it('returns msg unchanged for non-tools response', () => {
    const msg = { result: { content: [] } };
    const result = sanitizeToolsList(msg);
    assert.deepEqual(result, { result: { content: [] } });
  });
});

describe('sanitizeToolsList — annotation whitelisting', () => {
  it('keeps whitelisted MCP annotation fields', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        title: 'List Content',
      },
    })]);

    sanitizeToolsList(msg);

    const ann = msg.result.tools[0].annotations;
    assert.equal(ann.readOnlyHint, true);
    assert.equal(ann.destructiveHint, false);
    assert.equal(ann.idempotentHint, true);
    assert.equal(ann.openWorldHint, false);
    assert.equal(ann.title, 'List Content');
  });

  it('keeps permission and enabled fields', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        permission: 'read',
        enabled: true,
      },
    })]);

    sanitizeToolsList(msg);

    const ann = msg.result.tools[0].annotations;
    assert.equal(ann.permission, 'read');
    assert.equal(ann.enabled, true);
  });

  it('strips non-whitelisted annotation fields', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        permission: 'write',
        enabled: true,
        category: 'content',
        tier: 'free',
        bridgeHints: { foo: 'bar' },
        priority: 0.5,
        lastModified: '2026-01-01',
        audience: ['internal'],
      },
    })]);

    sanitizeToolsList(msg);

    const ann = msg.result.tools[0].annotations;
    assert.equal(ann.permission, 'write');
    assert.equal(ann.enabled, true);
    // These should be stripped
    assert.equal(ann.category, undefined);
    assert.equal(ann.tier, undefined);
    assert.equal(ann.bridgeHints, undefined);
    assert.equal(ann.priority, undefined);
    assert.equal(ann.lastModified, undefined);
    assert.equal(ann.audience, undefined);
  });

  it('removes annotations entirely when no whitelisted fields remain', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        category: 'content',
        tier: 'free',
      },
    })]);

    sanitizeToolsList(msg);

    assert.equal(msg.result.tools[0].annotations, undefined);
  });

  it('handles tool without annotations', () => {
    const msg = makeToolsListMsg([makeTool()]);
    sanitizeToolsList(msg);
    assert.equal(msg.result.tools[0].annotations, undefined);
  });
});

describe('sanitizeToolsList — [DISABLED] injection', () => {
  it('appends [DISABLED] to description when enabled: false', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        permission: 'write',
        enabled: false,
      },
    })]);

    sanitizeToolsList(msg);

    assert.ok(msg.result.tools[0].description.includes('[DISABLED'));
    assert.ok(msg.result.tools[0].description.includes("'write'"));
  });

  it('uses default permission "write" when not specified', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        enabled: false,
      },
    })]);

    sanitizeToolsList(msg);

    assert.ok(msg.result.tools[0].description.includes("'write'"));
  });

  it('uses actual permission level in [DISABLED] message', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        permission: 'delete',
        enabled: false,
      },
    })]);

    sanitizeToolsList(msg);

    assert.ok(msg.result.tools[0].description.includes("'delete'"));
  });

  it('does NOT append [DISABLED] when enabled: true', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        permission: 'read',
        enabled: true,
      },
    })]);

    sanitizeToolsList(msg);

    assert.ok(!msg.result.tools[0].description.includes('[DISABLED'));
  });

  it('does NOT double-append [DISABLED]', () => {
    const msg = makeToolsListMsg([makeTool({
      description: 'Already marked [DISABLED — requires write]',
      annotations: {
        permission: 'write',
        enabled: false,
      },
    })]);

    sanitizeToolsList(msg);

    // Should contain exactly one [DISABLED
    const matches = msg.result.tools[0].description.match(/\[DISABLED/g);
    assert.equal(matches.length, 1);
  });

  it('preserves original description when enabled is not set', () => {
    const msg = makeToolsListMsg([makeTool({
      annotations: {
        permission: 'read',
      },
    })]);

    sanitizeToolsList(msg);

    assert.equal(msg.result.tools[0].description, 'List content');
  });
});

describe('sanitizeToolsList — inputSchema normalization (#78)', () => {
  it('normalizes inputSchema: [] (PHP array() default) to {type:"object"}', () => {
    const msg = makeToolsListMsg([makeTool({ inputSchema: [] })]);
    sanitizeToolsList(msg);
    assert.deepEqual(msg.result.tools[0].inputSchema, { type: 'object' });
  });

  it('normalizes inputSchema: null to {type:"object"}', () => {
    const msg = makeToolsListMsg([makeTool({ inputSchema: null })]);
    sanitizeToolsList(msg);
    assert.deepEqual(msg.result.tools[0].inputSchema, { type: 'object' });
  });

  it('normalizes inputSchema: undefined to {type:"object"}', () => {
    const msg = makeToolsListMsg([makeTool({ inputSchema: undefined })]);
    sanitizeToolsList(msg);
    assert.deepEqual(msg.result.tools[0].inputSchema, { type: 'object' });
  });

  it('normalizes inputSchema: "invalid string" (primitive) to {type:"object"}', () => {
    const msg = makeToolsListMsg([makeTool({ inputSchema: 'invalid string' })]);
    sanitizeToolsList(msg);
    assert.deepEqual(msg.result.tools[0].inputSchema, { type: 'object' });
  });

  it('regression: valid inputSchema passes through byte-identical (no normalization, no mutation)', () => {
    const validSchema = { type: 'object', properties: { foo: { type: 'string' } } };
    const before = JSON.stringify(validSchema);
    const msg = makeToolsListMsg([makeTool({ inputSchema: validSchema })]);

    sanitizeToolsList(msg);

    const after = msg.result.tools[0].inputSchema;
    assert.equal(after, validSchema, 'inputSchema reference must be unchanged');
    assert.equal(JSON.stringify(after), before, 'inputSchema must be byte-identical post-sanitize');
    assert.deepEqual(after, { type: 'object', properties: { foo: { type: 'string' } } });
  });
});

describe('sanitizeToolsList — multiple tools', () => {
  it('processes each tool independently', () => {
    const msg = makeToolsListMsg([
      makeTool({
        name: 'content-list',
        description: 'List content',
        annotations: { permission: 'read', enabled: true },
      }),
      makeTool({
        name: 'content-create',
        description: 'Create content',
        annotations: { permission: 'write', enabled: false },
      }),
      makeTool({
        name: 'content-get',
        description: 'Get content',
        // no annotations
      }),
    ]);

    sanitizeToolsList(msg);

    // First tool: enabled, no DISABLED
    assert.ok(!msg.result.tools[0].description.includes('[DISABLED'));
    assert.equal(msg.result.tools[0].annotations.enabled, true);

    // Second tool: disabled, has DISABLED
    assert.ok(msg.result.tools[1].description.includes('[DISABLED'));
    assert.equal(msg.result.tools[1].annotations.enabled, false);

    // Third tool: no annotations at all
    assert.equal(msg.result.tools[2].annotations, undefined);
    assert.ok(!msg.result.tools[2].description.includes('[DISABLED'));
  });
});
