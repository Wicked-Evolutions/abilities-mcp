'use strict';

/**
 * Strip non-standard fields from tools/list responses that Claude Code rejects.
 * The wp-mcp-adapter adds "type" and "outputSchema" which aren't in the MCP spec
 * Tool schema. Claude Code silently drops the entire tool list when these are present.
 */
function sanitizeToolsList(msg) {
  if (!msg.result || !msg.result.tools || !Array.isArray(msg.result.tools)) return msg;

  for (const tool of msg.result.tools) {
    delete tool.type;
    delete tool.outputSchema;
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
