'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildEnvConfig } = require('../lib/config');

describe('buildEnvConfig', () => {
  it('builds a single-site http config from URL/USERNAME/PASSWORD', () => {
    const config = buildEnvConfig({
      ABILITIES_MCP_URL: 'https://example.com',
      ABILITIES_MCP_USERNAME: 'mcp-agent',
      ABILITIES_MCP_PASSWORD: 'xxxx xxxx xxxx xxxx',
    });

    assert.equal(config.defaultSite, 'default');
    assert.equal(config._isMultiSite, false);
    assert.equal(config._configSource, 'env');

    const site = config.sites.default;
    assert.equal(site.transport, 'http');
    assert.equal(site.http.username, 'mcp-agent');
    assert.equal(site.http.password, 'xxxx xxxx xxxx xxxx');
  });

  it('auto-derives endpoint from site URL', () => {
    const config = buildEnvConfig({
      ABILITIES_MCP_URL: 'https://example.com',
      ABILITIES_MCP_USERNAME: 'u',
      ABILITIES_MCP_PASSWORD: 'p',
    });
    assert.equal(
      config.sites.default.http.endpoint,
      'https://example.com/wp-json/mcp/mcp-adapter-default-server'
    );
  });

  it('strips trailing slash from URL when deriving endpoint', () => {
    const config = buildEnvConfig({
      ABILITIES_MCP_URL: 'https://example.com/',
      ABILITIES_MCP_USERNAME: 'u',
      ABILITIES_MCP_PASSWORD: 'p',
    });
    assert.equal(
      config.sites.default.http.endpoint,
      'https://example.com/wp-json/mcp/mcp-adapter-default-server'
    );
  });

  it('preserves a subdirectory path in the URL when deriving endpoint', () => {
    const config = buildEnvConfig({
      ABILITIES_MCP_URL: 'https://example.com/wp',
      ABILITIES_MCP_USERNAME: 'u',
      ABILITIES_MCP_PASSWORD: 'p',
    });
    assert.equal(
      config.sites.default.http.endpoint,
      'https://example.com/wp/wp-json/mcp/mcp-adapter-default-server'
    );
  });

  it('throws when USERNAME is missing', () => {
    assert.throws(
      () => buildEnvConfig({
        ABILITIES_MCP_URL: 'https://example.com',
        ABILITIES_MCP_PASSWORD: 'p',
      }),
      /ABILITIES_MCP_USERNAME is missing/
    );
  });

  it('throws when PASSWORD is missing', () => {
    assert.throws(
      () => buildEnvConfig({
        ABILITIES_MCP_URL: 'https://example.com',
        ABILITIES_MCP_USERNAME: 'u',
      }),
      /ABILITIES_MCP_PASSWORD is missing/
    );
  });

  it('throws when URL is not a valid URL', () => {
    assert.throws(
      () => buildEnvConfig({
        ABILITIES_MCP_URL: 'not-a-url',
        ABILITIES_MCP_USERNAME: 'u',
        ABILITIES_MCP_PASSWORD: 'p',
      }),
      /not a valid URL/
    );
  });

  it('throws when URL uses an unsupported scheme', () => {
    assert.throws(
      () => buildEnvConfig({
        ABILITIES_MCP_URL: 'ftp://example.com',
        ABILITIES_MCP_USERNAME: 'u',
        ABILITIES_MCP_PASSWORD: 'p',
      }),
      /must be http or https/
    );
  });

  it('rejects plain HTTP for non-local hosts by default', () => {
    assert.throws(
      () => buildEnvConfig({
        ABILITIES_MCP_URL: 'http://example.com',
        ABILITIES_MCP_USERNAME: 'u',
        ABILITIES_MCP_PASSWORD: 'p',
      }),
      /HTTP \(not HTTPS\)/
    );
  });

  it('allows plain HTTP for localhost without opt-in', () => {
    const config = buildEnvConfig({
      ABILITIES_MCP_URL: 'http://localhost:8080',
      ABILITIES_MCP_USERNAME: 'u',
      ABILITIES_MCP_PASSWORD: 'p',
    });
    assert.equal(config.sites.default.allowInsecure, true);
    assert.equal(
      config.sites.default.http.endpoint,
      'http://localhost:8080/wp-json/mcp/mcp-adapter-default-server'
    );
  });

  it('allows plain HTTP for non-local when ABILITIES_MCP_ALLOW_INSECURE=true', () => {
    const config = buildEnvConfig({
      ABILITIES_MCP_URL: 'http://example.com',
      ABILITIES_MCP_USERNAME: 'u',
      ABILITIES_MCP_PASSWORD: 'p',
      ABILITIES_MCP_ALLOW_INSECURE: 'true',
    });
    assert.equal(config.sites.default.allowInsecure, true);
  });
});
