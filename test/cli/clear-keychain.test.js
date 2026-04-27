'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { makeHarness } = require('./helpers/cli-harness');

describe('CLI clear-keychain', () => {
  let h;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.cleanup());

  it('deletes only entries matching the site_id prefix', async () => {
    await h.ctx.secretStore.set('abilities-mcp', 'siteA/access', 'AT-A');
    await h.ctx.secretStore.set('abilities-mcp', 'siteA/refresh', 'RT-A');
    await h.ctx.secretStore.set('abilities-mcp', 'siteA/apppassword', 'PW-A');
    await h.ctx.secretStore.set('abilities-mcp', 'siteB/access', 'AT-B');
    await h.ctx.secretStore.set('abilities-mcp', 'siteAA/access', 'AT-AA');

    const r = await h.runCli('clear-keychain', ['siteA']);
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /Removed 3 keychain entries/);

    const remaining = await h.ctx.secretStore.findAll('abilities-mcp');
    const accounts = remaining.map((e) => e.account).sort();
    assert.deepEqual(accounts, ['siteAA/access', 'siteB/access']);
  });

  it('idempotent — second run says nothing to do', async () => {
    const r = await h.runCli('clear-keychain', ['ghost']);
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /No keychain entries found for "ghost"/);
  });

  it('refuses path-traversal-style site_ids', async () => {
    const r = await h.runCli('clear-keychain', ['../foo']);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /invalid site_id/);
  });

  it('errors without a site_id', async () => {
    const r = await h.runCli('clear-keychain', []);
    assert.equal(r.exitCode, 2);
    assert.match(r.errLines.join('\n'), /requires a site_id/);
  });
});
