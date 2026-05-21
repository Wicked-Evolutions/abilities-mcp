'use strict';

/**
 * Adapter-tool schema overlays (issue #97 + adapter #128).
 *
 * Some adapter-side tools accept filter / pagination parameters that the
 * adapter has registered in source since v1.2.0, but the parameters do not
 * always reach the AI client as part of the `tools/list` projection — when
 * an upstream layer projects an empty `inputSchema`, the bridge's defensive
 * sanitizer normalizes it to `{ type: 'object' }`, after which AI clients
 * have no way to know the optional params exist.
 *
 * The overlay is a thin pass-through assertion: the bridge advertises the
 * params it knows the adapter accepts, merged ADDITIVELY into whatever the
 * adapter's projection already advertised. If the adapter advertises a
 * property already, the adapter's version wins (so a future adapter rename
 * does not collide). The adapter remains authoritative on runtime semantics —
 * the bridge only states what the AI client may pass.
 *
 * Keyed by MCP tool name (slash → hyphen): `mcp-adapter/discover-abilities`
 * becomes `mcp-adapter-discover-abilities` on the wire.
 *
 * Mirror of `src/Abilities/DiscoverAbilitiesAbility.php` register() input_schema
 * (adapter is authoritative on parameter names and runtime bounds).
 */
const ADAPTER_TOOL_SCHEMA_OVERLAYS = {
  'mcp-adapter-discover-abilities': {
    properties: {
      category: {
        type: 'string',
        description:
          'Filter by ability category slug (e.g. "content", "taxonomies", "fluent-crm"). Optional pass-through to the adapter.',
      },
      annotation: {
        type: 'string',
        enum: ['readonly', 'destructive'],
        description:
          'Filter by meta annotation: "readonly" for safe read operations, "destructive" for delete operations. Optional pass-through to the adapter.',
      },
      search: {
        type: 'string',
        description:
          'Case-insensitive substring match against ability name, label, and description. Optional pass-through to the adapter.',
      },
      compact: {
        type: 'boolean',
        description:
          'When true, returns only name, category, and tier per ability — skips label, description, and schemas. Use to keep large catalogs inside the AI client\'s tool-result token budget. Optional pass-through to the adapter.',
      },
      limit: {
        type: 'integer',
        minimum: 0,
        maximum: 200,
        description:
          'Maximum number of abilities to return. Adapter caps at 200. Use with offset for paging through large catalogs. Optional pass-through to the adapter.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description:
          'Number of abilities to skip before returning results. Use with limit for paging. Optional pass-through to the adapter.',
      },
    },
  },
};

/**
 * Apply the known-adapter-tool schema overlays to a tools/list response.
 * Additive: if the adapter's projection already advertises a property, the
 * adapter's version wins. Mutates `msg` in place.
 *
 * @param {object} msg - The full JSON-RPC tools/list response
 * @returns {object} The mutated response
 */
function applyAdapterToolSchemaOverlays(msg) {
  if (!msg || !msg.result || !Array.isArray(msg.result.tools)) return msg;

  for (const tool of msg.result.tools) {
    if (!tool || typeof tool.name !== 'string') continue;
    const overlay = ADAPTER_TOOL_SCHEMA_OVERLAYS[tool.name];
    if (!overlay) continue;

    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
      tool.inputSchema = { type: 'object' };
    }
    if (tool.inputSchema.type === undefined) {
      tool.inputSchema.type = 'object';
    }
    if (!tool.inputSchema.properties || typeof tool.inputSchema.properties !== 'object' || Array.isArray(tool.inputSchema.properties)) {
      tool.inputSchema.properties = {};
    }

    // Adapter wins on collisions — only add properties the adapter did not
    // already advertise. The bridge stays a thin pass-through that asserts
    // what it knows the adapter accepts without overriding adapter intent.
    for (const [propName, propDef] of Object.entries(overlay.properties)) {
      if (!(propName in tool.inputSchema.properties)) {
        tool.inputSchema.properties[propName] = propDef;
      }
    }
  }

  return msg;
}

/**
 * Inject a `site` parameter into every tool in a tools/list response.
 * This is the core of multi-site routing — the LLM sees `site` as an optional
 * enum parameter on every tool and specifies which WordPress site to target.
 *
 * @param {object} msg - The full JSON-RPC tools/list response (mutated in place)
 * @param {string[]} siteKeys - All available site keys (including multisite composites)
 * @param {string} defaultSite - The default site key
 * @returns {object} The modified response
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
function injectSiteParam(msg, siteKeys, defaultSite) {
  if (!msg.result || !msg.result.tools || !Array.isArray(msg.result.tools)) return msg;

  const siteDesc = `Target WordPress site. Available: ${siteKeys.join(', ')}. Default: ${defaultSite}`;

  for (const tool of msg.result.tools) {
    if (!tool.inputSchema) {
      tool.inputSchema = { type: 'object', properties: {} };
    }
    if (!tool.inputSchema.properties) {
      tool.inputSchema.properties = {};
    }

    tool.inputSchema.properties.site = {
      type: 'string',
      description: siteDesc,
      enum: siteKeys,
    };

    // Do NOT add 'site' to required — it's optional, defaults to defaultSite
  }

  return msg;
}

/**
 * Extract and remove the `site` parameter from a tools/call arguments object.
 * Returns the site key and the cleaned arguments (without `site`).
 */
function extractSiteParam(args, defaultSite) {
  if (!args || typeof args !== 'object') return { site: defaultSite, cleanArgs: args || {} };
  const { site, ...cleanArgs } = args;
  return { site: site || defaultSite, cleanArgs };
}

module.exports = {
  injectSiteParam,
  extractSiteParam,
  applyAdapterToolSchemaOverlays,
  ADAPTER_TOOL_SCHEMA_OVERLAYS,
};
