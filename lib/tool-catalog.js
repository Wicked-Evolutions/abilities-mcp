'use strict';

/**
 * Tool Catalog — caches the full tools list and provides category-based filtering.
 *
 * When toolFilter is enabled, tools/list responses are filtered to only include
 * essential tools + activated categories + bridge tools. The model uses
 * wp_browse_tools and wp_load_tools to discover and activate categories on demand.
 *
 * Categories are extracted dynamically from tool names using prefix patterns:
 *   fluent-crm-*     → fluent-crm
 *   fluent-community-* → fluent-community
 *   mcp-adapter-*    → mcp-adapter
 *   content-*        → content
 *   media-*          → media
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
class ToolCatalog {

  constructor(config, logger) {
    this.log = logger || function noop() {};
    this.filterConfig = config.toolFilter || null;

    // Full tools list from WordPress (cached on first tools/list response)
    this.fullTools = null;

    // Category index: categoryName → [tool objects]
    this.categories = {};

    // Active (loaded) categories
    this.activeCategories = new Set();

    // Resolve "always-include" categories once. Explicit operator config wins
    // (including an explicit empty list, which preserves the operator's choice).
    // When filtering is enabled and the operator hasn't set their own list,
    // default to ['mcp-adapter'] so the cross-site adapter meta-tools
    // (mcp-adapter-discover-abilities / -get-ability-info / -execute-ability)
    // are always visible without requiring a prior wp_load_tools call.
    const explicit = this.filterConfig && this.filterConfig.alwaysIncludeCategories;
    const resolved =
      explicit !== undefined && explicit !== null
        ? explicit
        : this.isEnabled()
        ? ['mcp-adapter']
        : [];
    this.effectiveAlwaysInclude = new Set(resolved);
    for (const cat of this.effectiveAlwaysInclude) {
      this.activeCategories.add(cat);
    }
  }

  /**
   * Whether filtering is enabled.
   */
  isEnabled() {
    return !!(this.filterConfig && this.filterConfig.enabled);
  }

  /**
   * Cache the full tools list and build the category index.
   * Called when the first tools/list response arrives from WordPress.
   */
  cacheTools(tools) {
    this.fullTools = tools;
    this.categories = {};

    for (const tool of tools) {
      const cat = this._extractCategory(tool.name);
      if (!this.categories[cat]) this.categories[cat] = [];
      this.categories[cat].push(tool);
    }

    this.log(`Tool catalog: ${tools.length} tools in ${Object.keys(this.categories).length} categories`);
  }

  /**
   * Get a filtered tools list based on active categories + essential tools.
   * Returns a new array (does not mutate the cached list).
   */
  getFilteredTools() {
    if (!this.fullTools) return [];

    const essentialNames = new Set(
      (this.filterConfig && this.filterConfig.essentialTools) || []
    );

    const result = [];
    for (const tool of this.fullTools) {
      const cat = this._extractCategory(tool.name);
      if (this.activeCategories.has(cat) || essentialNames.has(tool.name)) {
        result.push(tool);
      }
    }

    return result;
  }

  /**
   * Activate one or more categories. Returns list of newly activated category names.
   */
  activateCategories(categoryNames) {
    const activated = [];
    for (const name of categoryNames) {
      if (this.categories[name] && !this.activeCategories.has(name)) {
        this.activeCategories.add(name);
        activated.push(name);
      }
    }
    return activated;
  }

  /**
   * Deactivate categories (return to compact mode).
   */
  deactivateCategories(categoryNames) {
    // Don't deactivate always-included categories (single source of truth:
    // the set resolved at construction, so the default mcp-adapter inclusion
    // is treated the same as an explicit operator-configured entry).
    for (const name of categoryNames) {
      if (!this.effectiveAlwaysInclude.has(name)) {
        this.activeCategories.delete(name);
      }
    }
  }

  /**
   * Get category summary for wp_browse_tools.
   * Returns array of { name, toolCount, active, tools[] }
   */
  getCategorySummary() {
    const summary = [];
    for (const [name, tools] of Object.entries(this.categories)) {
      summary.push({
        name,
        toolCount: tools.length,
        active: this.activeCategories.has(name),
        tools: tools.map(t => t.name),
      });
    }
    return summary.sort((a, b) => b.toolCount - a.toolCount);
  }

  /**
   * Extract category from a tool name.
   * Handles compound prefixes: fluent-crm-*, fluent-community-*, mcp-adapter-*, event-bridge-*
   */
  _extractCategory(name) {
    return extractCategoryFromName(name);
  }
}

/**
 * Extract a category from a tool name. Module-level + pure so read-only
 * cross-site browsing (C1) can reuse the exact same prefix logic without
 * constructing a ToolCatalog or touching any instance state.
 *
 * Handles compound prefixes: fluent-crm-*, fluent-community-*, mcp-adapter-*, event-bridge-*
 *
 * @param {string} name - Tool name.
 * @returns {string} Category name.
 */
function extractCategoryFromName(name) {
  const parts = String(name).split('-');

  // Compound prefixes where first segment is ambiguous
  if (parts.length >= 3) {
    const twoWord = parts[0] + '-' + parts[1];
    if (['fluent-crm', 'fluent-community', 'fluent-boards', 'fluent-support',
         'fluent-forms', 'fluent-booking', 'fluent-messaging', 'fluent-smtp',
         'fluent-auth', 'fluent-snippets', 'fluent-get', 'fluent-onboard',
         'mcp-adapter', 'event-bridge'].includes(twoWord)) {
      return twoWord;
    }
  }

  return parts[0];
}

/**
 * Build a category summary from a raw tools array WITHOUT constructing or
 * mutating any ToolCatalog instance state. Used by the read-only cross-site
 * browse path (C1) — `wp_browse_tools { site: <non-default> }` — so the global
 * catalog (scoped to the connected default site) stays byte-untouched.
 *
 * Returns the same `{ name, toolCount, tools }` shape as
 * `ToolCatalog.getCategorySummary()` but deliberately omits the `active` flag:
 * activation state is a default-site concept (per C2 there is no per-site
 * activation), so a cross-site browse reports counts only, never load-state.
 *
 * @param {Array} tools - Tools array from a tools/list response.
 * @returns {Array<{name: string, toolCount: number, tools: string[]}>}
 */
function buildCategorySummaryFromTools(tools) {
  const categories = {};
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string') continue;
      const cat = extractCategoryFromName(tool.name);
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(tool.name);
    }
  }

  const summary = [];
  for (const [name, toolNames] of Object.entries(categories)) {
    summary.push({ name, toolCount: toolNames.length, tools: toolNames });
  }
  return summary.sort((a, b) => b.toolCount - a.toolCount);
}

module.exports = { ToolCatalog, extractCategoryFromName, buildCategorySummaryFromTools };
