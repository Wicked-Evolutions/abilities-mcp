'use strict';

/**
 * Bridge tools — synthetic tools handled locally, never forwarded to WordPress.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */

const BRIDGE_TOOLS = [
  {
    name: 'wp_bridge_health',
    description: 'Check connectivity status of all configured WordPress sites. Returns status (connected/reachable/unreachable) and latency for each site.',
    inputSchema: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          description: 'Optional: check only this site. Omit to check all configured sites.',
        },
      },
    },
  },
  {
    name: 'wp_browse_tools',
    description:
      'List categories in the bridge\'s direct-tool catalog (scoped to defaultSite) with tool counts and load-state. This is the local-catalog control surface — not full cross-site ability discovery. For abilities on another site, or in a category not listed here, use mcp-adapter-discover-abilities / mcp-adapter-execute-ability with { site }.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wp_load_tools',
    description:
      'Activate categories in the bridge\'s direct-tool catalog (scoped to defaultSite) to expose their tools in tools/list. This is the local-catalog control surface — not full cross-site ability discovery. If a requested category is not in the local catalog, the response points to mcp-adapter-discover-abilities + mcp-adapter-execute-ability for the cross-site path.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Category names to activate from the direct-tool catalog (e.g. ["fluent-crm", "content", "media"]). Use wp_browse_tools to see available categories. Categories not in the local catalog return a pointer to mcp-adapter-discover-abilities instead of silently activating nothing.',
        },
        deactivate: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: category names to deactivate (unload from the tools list).',
        },
      },
      required: ['categories'],
    },
  },
];

const BRIDGE_TOOL_NAMES = new Set(BRIDGE_TOOLS.map(t => t.name));

function isBridgeTool(name) {
  return BRIDGE_TOOL_NAMES.has(name);
}

function injectBridgeTools(msg) {
  if (!msg.result || !Array.isArray(msg.result.tools)) return;
  for (const tool of BRIDGE_TOOLS) {
    msg.result.tools.push(tool);
  }
}

module.exports = { BRIDGE_TOOLS, isBridgeTool, injectBridgeTools };
