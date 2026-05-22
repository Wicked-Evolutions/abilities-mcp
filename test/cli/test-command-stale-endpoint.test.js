'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeHarness, v2SiteOAuth } = require('./helpers/cli-harness');
const { SCHEMA_VERSION } = require('../../lib/auth/schema-v2');
const {
  detectLegacyEndpoint,
  LEGACY_SERVER_SEGMENT,
  CURRENT_SERVER_SEGMENT,
} = require('../../lib/cli/config-store');

/**
 * Stale-endpoint detection for issue #95 (bridge v1.6.5).
 *
 * Adapter v1.4.9 renames its default MCP server name from
 * "mcp-adapter-default-server" to "abilities-mcp-adapter-default-server".
 * Existing wp-sites.json configs carry the old name on mcp_resource /
 * http.endpoint. `test <site_id>` surfaces a plain-language remediation
 * message before the bearer/probe flow so the operator updates the JSON
 * file instead of seeing a defunct-path 401/404 cascade.
 */

describe('detectLegacyEndpoint() — pure helper', () => {
  it('returns empty array when site has no URL fields', () => {
    assert.deepEqual(detectLegacyEndpoint({}), []);
    assert.deepEqual(detectLegacyEndpoint(null), []);
  });

  it('returns empty array when URLs already use the new server name', () => {
    const site = {
      mcp_resource: `https://example.com${CURRENT_SERVER_SEGMENT}`,
      http: { endpoint: `https://example.com${CURRENT_SERVER_SEGMENT}` },
    };
    assert.deepEqual(detectLegacyEndpoint(site), []);
  });

  it('flags mcp_resource when it still points at the legacy name', () => {
    const site = {
      mcp_resource: `https://example.com${LEGACY_SERVER_SEGMENT}`,
    };
    const findings = detectLegacyEndpoint(site);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].field, 'mcp_resource');
    assert.equal(findings[0].oldUrl, `https://example.com${LEGACY_SERVER_SEGMENT}`);
    assert.equal(findings[0].newUrl, `https://example.com${CURRENT_SERVER_SEGMENT}`);
  });

  it('flags http.endpoint independently from mcp_resource', () => {
    const site = {
      mcp_resource: `https://example.com${CURRENT_SERVER_SEGMENT}`,
      http: { endpoint: `https://example.com${LEGACY_SERVER_SEGMENT}` },
    };
    const findings = detectLegacyEndpoint(site);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].field, 'http.endpoint');
  });

  it('flags auth.mcp_resource (alternate v2 OAuth storage location)', () => {
    const site = {
      auth: { mcp_resource: `https://example.com${LEGACY_SERVER_SEGMENT}` },
    };
    const findings = detectLegacyEndpoint(site);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].field, 'auth.mcp_resource');
  });

  it('flags every stale field independently when more than one is present', () => {
    const site = {
      mcp_resource: `https://example.com${LEGACY_SERVER_SEGMENT}`,
      http: { endpoint: `https://example.com${LEGACY_SERVER_SEGMENT}` },
    };
    const findings = detectLegacyEndpoint(site);
    assert.equal(findings.length, 2);
    const fields = findings.map((f) => f.field).sort();
    assert.deepEqual(fields, ['http.endpoint', 'mcp_resource']);
  });

  it('does not false-positive on a URL whose path happens to contain the suffix as a substring elsewhere', () => {
    // The detector only matches the full path segment; an unrelated URL
    // should not be flagged even if the literal substring appears.
    const site = {
      mcp_resource: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server-extra',
    };
    assert.deepEqual(detectLegacyEndpoint(site), []);
  });
});

describe('CLI test <site_id> — stale endpoint pre-flight (#95)', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  it('blocks the bearer flow and prints migration instructions when mcp_resource is stale', async () => {
    const stale = v2SiteOAuth('https://example.com');
    stale.mcp_resource = `https://example.com${LEGACY_SERVER_SEGMENT}`;
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: { staleSite: stale },
    });
    // Wire a request fn that would fail the test if reached — the pre-flight
    // must throw before any network call.
    const fakeRequest = async () => {
      throw new Error('should not be called when pre-flight detects stale endpoint');
    };
    const r = await h.runCli('test', ['staleSite'], { request: fakeRequest });
    assert.equal(r.exitCode, 2);
    const joined = r.errLines.join('\n');
    assert.match(joined, /pointing at the old adapter server name/);
    assert.match(joined, /mcp-adapter-default-server/);
    assert.match(joined, /abilities-mcp-adapter-default-server/);
    assert.match(joined, /abilities-mcp test staleSite/);
  });

  it('does not block when stored URLs already use the new server name', async () => {
    const site = v2SiteOAuth('https://example.com');
    site.mcp_resource = `https://example.com${CURRENT_SERVER_SEGMENT}`;
    h.writeConfig({
      schema_version: SCHEMA_VERSION,
      sites: { freshSite: site },
    });
    // Stub deps so the test does not reach the network — we only assert the
    // pre-flight DID NOT short-circuit. The OAuth discover path is reached;
    // if discovery throws, fine — we just verify the message is not the
    // pre-flight message.
    const r = await h.runCli('test', ['freshSite']);
    const joined = (r.lines || []).concat(r.errLines || []).join('\n');
    assert.doesNotMatch(joined, /pointing at the old adapter server name/);
  });
});
