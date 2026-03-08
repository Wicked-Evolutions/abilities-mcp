'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ToolCatalog } = require('../lib/tool-catalog');

function makeCatalog(opts = {}) {
  const config = {
    toolFilter: {
      enabled: true,
      essentialTools: opts.essentialTools || ['mcp-adapter-discover-abilities'],
      alwaysIncludeCategories: opts.alwaysIncludeCategories || ['mcp-adapter'],
    },
  };
  return new ToolCatalog(config);
}

const SAMPLE_TOOLS = [
  { name: 'content-list' },
  { name: 'content-get' },
  { name: 'content-create' },
  { name: 'media-list' },
  { name: 'media-upload' },
  { name: 'fluent-crm-list-contacts' },
  { name: 'fluent-crm-get-contact' },
  { name: 'mcp-adapter-discover-abilities' },
  { name: 'mcp-adapter-get-ability-info' },
];

describe('ToolCatalog', () => {
  it('isEnabled returns true when toolFilter.enabled', () => {
    const catalog = makeCatalog();
    assert.equal(catalog.isEnabled(), true);
  });

  it('isEnabled returns false when no toolFilter', () => {
    const catalog = new ToolCatalog({});
    assert.equal(catalog.isEnabled(), false);
  });

  it('cacheTools builds category index', () => {
    const catalog = makeCatalog();
    catalog.cacheTools(SAMPLE_TOOLS);
    assert.equal(catalog.fullTools.length, 9);

    const summary = catalog.getCategorySummary();
    const catNames = summary.map(c => c.name);
    assert.ok(catNames.includes('content'));
    assert.ok(catNames.includes('media'));
    assert.ok(catNames.includes('fluent-crm'));
    assert.ok(catNames.includes('mcp-adapter'));
  });

  it('getFilteredTools returns only essential + always-included by default', () => {
    const catalog = makeCatalog();
    catalog.cacheTools(SAMPLE_TOOLS);

    const filtered = catalog.getFilteredTools();
    const names = filtered.map(t => t.name);

    // mcp-adapter category is always included
    assert.ok(names.includes('mcp-adapter-discover-abilities'));
    assert.ok(names.includes('mcp-adapter-get-ability-info'));

    // Other categories should not be included
    assert.ok(!names.includes('content-list'));
    assert.ok(!names.includes('fluent-crm-list-contacts'));
  });

  it('activateCategories loads additional tools', () => {
    const catalog = makeCatalog();
    catalog.cacheTools(SAMPLE_TOOLS);

    const activated = catalog.activateCategories(['content']);
    assert.deepEqual(activated, ['content']);

    const filtered = catalog.getFilteredTools();
    const names = filtered.map(t => t.name);
    assert.ok(names.includes('content-list'));
    assert.ok(names.includes('content-get'));
    assert.ok(names.includes('content-create'));
  });

  it('activateCategories ignores unknown categories', () => {
    const catalog = makeCatalog();
    catalog.cacheTools(SAMPLE_TOOLS);

    const activated = catalog.activateCategories(['nonexistent']);
    assert.deepEqual(activated, []);
  });

  it('deactivateCategories removes loaded categories', () => {
    const catalog = makeCatalog();
    catalog.cacheTools(SAMPLE_TOOLS);

    catalog.activateCategories(['content']);
    catalog.deactivateCategories(['content']);

    const filtered = catalog.getFilteredTools();
    const names = filtered.map(t => t.name);
    assert.ok(!names.includes('content-list'));
  });

  it('deactivateCategories does not remove always-included', () => {
    const catalog = makeCatalog();
    catalog.cacheTools(SAMPLE_TOOLS);

    catalog.deactivateCategories(['mcp-adapter']);

    const filtered = catalog.getFilteredTools();
    const names = filtered.map(t => t.name);
    assert.ok(names.includes('mcp-adapter-discover-abilities'));
  });

  it('getCategorySummary returns sorted by toolCount', () => {
    const catalog = makeCatalog();
    catalog.cacheTools(SAMPLE_TOOLS);

    const summary = catalog.getCategorySummary();
    // content (3) >= mcp-adapter (2) >= media (2) >= fluent-crm (2)
    assert.ok(summary[0].toolCount >= summary[summary.length - 1].toolCount);
  });

  it('compound prefix extraction works for fluent-crm', () => {
    const catalog = makeCatalog();
    catalog.cacheTools([
      { name: 'fluent-crm-list-contacts' },
      { name: 'fluent-crm-get-contact' },
      { name: 'fluent-community-list-feeds' },
    ]);

    const summary = catalog.getCategorySummary();
    const catNames = summary.map(c => c.name);
    assert.ok(catNames.includes('fluent-crm'));
    assert.ok(catNames.includes('fluent-community'));
  });
});
