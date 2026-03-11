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
    description: 'List available WordPress tool categories with tool counts. Shows which categories are currently loaded. Use wp_load_tools to activate categories.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wp_load_tools',
    description: 'Activate WordPress tool categories to make their tools available. After loading, the tools list is automatically refreshed.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Category names to activate (e.g. ["fluent-crm", "content", "media"]). Use wp_browse_tools to see available categories.',
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
