'use strict';

/**
 * Annotation fields to preserve from WordPress tool definitions.
 * These are read before the annotations object is stripped for protocol compliance.
 *
 * Copyright (C) 2026 Influencentricity | Wicked Evolutions
 * @license GPL-2.0-or-later
 */
const ANNOTATION_WHITELIST = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint', 'title', 'permission', 'enabled'];

const VALID_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];

/**
 * Validate a tool's inputSchema and log warnings for common issues.
 * Does NOT block tools — warnings only (debug log).
 *
 * @param {string} toolName - Tool name for log context.
 * @param {object} schema - The inputSchema object.
 * @param {function} log - Logger function (noop when debug disabled).
 */
function validateToolSchema(toolName, schema, log) {
  if (!schema || typeof schema !== 'object') {
    log(`SCHEMA WARN [${toolName}]: inputSchema is not an object`);
    return;
  }

  if (schema.type && !VALID_SCHEMA_TYPES.includes(schema.type)) {
    log(`SCHEMA WARN [${toolName}]: invalid top-level type "${schema.type}"`);
  }

  // Boundary: properties key absent — leave inputSchema byte-unchanged.
  if (schema.properties === undefined) return;

  // Normalize malformed `properties` shapes (PHP `array()` JSON-encodes to `[]`,
  // strings, null, primitives) to `{}` before downstream validation. Anthropic's
  // draft 2020-12 validator rejects the entire tools/list payload on the first
  // invalid schema, so a single vendor-registered `properties: []` breaks the
  // whole catalog. Mirror of the top-level inputSchema normalize one frame up.
  if (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    log(`SCHEMA NORMALIZE [${toolName}]: inputSchema.properties not a plain object — normalized to {}`);
    schema.properties = {};
    return;
  }

  for (const [prop, def] of Object.entries(schema.properties)) {
    if (!def || typeof def !== 'object') {
      log(`SCHEMA WARN [${toolName}]: property "${prop}" is not an object`);
      continue;
    }
    if (def.type && !VALID_SCHEMA_TYPES.includes(def.type)) {
      log(`SCHEMA WARN [${toolName}]: property "${prop}" has invalid type "${def.type}"`);
    }
    if (def.type === 'array' && !def.items) {
      log(`SCHEMA WARN [${toolName}]: property "${prop}" is array type but missing "items"`);
    }
  }
}

/**
 * Sanitize tools/list responses for protocol compliance.
 *
 * 1. Strips non-standard fields (type, outputSchema) that Claude Code rejects.
 * 2. Validates schemas and logs warnings for common issues (debug mode).
 * 3. Reads permission metadata from annotations before stripping:
 *    - Keeps whitelisted annotation fields (MCP spec + permission/enabled).
 *    - Appends [DISABLED — requires '{permission}' permission] to description
 *      when enabled: false, so the LLM sees the tool is gated.
 * 4. Removes annotations entirely if no whitelisted fields remain.
 */
function sanitizeToolsList(msg, log) {
  if (!msg.result || !msg.result.tools || !Array.isArray(msg.result.tools)) return msg;

  const _log = typeof log === 'function' ? log : function noop() {};

  for (const tool of msg.result.tools) {
    delete tool.type;
    delete tool.outputSchema;

    // Normalize broken or non-object inputSchema (defensive — broken upstream
    // schemas would otherwise 400 the API and break the entire tool list).
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
      if (tool.inputSchema !== undefined) {
        _log(`SCHEMA NORMALIZE [${tool.name || '(unnamed)'}]: inputSchema not a valid object — defaulted to {type:'object'}`);
      }
      tool.inputSchema = { type: 'object' };
    } else {
      validateToolSchema(tool.name || '(unnamed)', tool.inputSchema, _log);
    }

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
