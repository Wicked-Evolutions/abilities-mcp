'use strict';

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

module.exports = { injectSiteParam, extractSiteParam };
