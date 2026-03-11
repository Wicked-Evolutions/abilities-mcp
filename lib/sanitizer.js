'use strict';

/**
 * Annotation fields to preserve from WordPress tool definitions.
 * These are read before the annotations object is stripped for protocol compliance.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
const ANNOTATION_WHITELIST = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint', 'title', 'permission', 'enabled'];

/**
 * Sanitize tools/list responses for protocol compliance.
 *
 * 1. Strips non-standard fields (type, outputSchema) that Claude Code rejects.
 * 2. Reads permission metadata from annotations before stripping:
 *    - Keeps whitelisted annotation fields (MCP spec + permission/enabled).
 *    - Appends [DISABLED — requires '{permission}' permission] to description
 *      when enabled: false, so the LLM sees the tool is gated.
 * 3. Removes annotations entirely if no whitelisted fields remain.
 */
function sanitizeToolsList(msg) {
  if (!msg.result || !msg.result.tools || !Array.isArray(msg.result.tools)) return msg;

  for (const tool of msg.result.tools) {
    delete tool.type;
    delete tool.outputSchema;

    // Process annotations: read before stripping
    if (tool.annotations && typeof tool.annotations === 'object') {
      // Inject [DISABLED] into description when enabled is explicitly false
      if (tool.annotations.enabled === false) {
        const permission = tool.annotations.permission || 'write';
        const suffix = ` [DISABLED — requires '${permission}' permission]`;
        if (tool.description && !tool.description.includes('[DISABLED')) {
          tool.description += suffix;
        }
      }

      // Keep only whitelisted annotation fields
      const filtered = {};
      for (const key of ANNOTATION_WHITELIST) {
        if (key in tool.annotations) {
          filtered[key] = tool.annotations[key];
        }
      }

      // Set filtered annotations or remove entirely if empty
      if (Object.keys(filtered).length > 0) {
        tool.annotations = filtered;
      } else {
        delete tool.annotations;
      }
    }
  }

  return msg;
}

/**
 * Check if a parsed JSON-RPC message is a tools/list response.
 */
function isToolsListResponse(msg) {
  return !!(msg.result && Array.isArray(msg.result.tools));
}

module.exports = { sanitizeToolsList, isToolsListResponse };
