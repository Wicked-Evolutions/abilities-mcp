'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { openBrowser, _commandFor, _needsVerbatim } = require('../../lib/auth/browser-launcher');

describe('browser-launcher', () => {
  it('selects the right command per platform', () => {
    assert.deepEqual(_commandFor('darwin'), { cmd: 'open', args: [] });
    assert.deepEqual(_commandFor('win32'), { cmd: 'cmd', args: ['/c', 'start', ''] });
    assert.deepEqual(_commandFor('linux'), { cmd: 'xdg-open', args: [] });
  });

  it('rejects non-http(s) URLs', async () => {
    await assert.rejects(openBrowser('javascript:alert(1)'), /non-http/);
    await assert.rejects(openBrowser('file:///etc/passwd'), /non-http/);
  });

  it('rejects empty url', async () => {
    await assert.rejects(openBrowser(''), /non-empty string/);
  });

  it('honors the launcher override (DI)', async () => {
    const calls = [];
    const result = await openBrowser('https://example.com', {
      launcher: async (url) => { calls.push(url); },
    });
    assert.deepEqual(calls, ['https://example.com']);
    assert.equal(result.spawned, true);
    assert.equal(result.platform, 'override');
  });

  it('passes URL with ampersands intact via launcher override', async () => {
    const url = 'https://example.com/oauth/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fcallback';
    const calls = [];
    await openBrowser(url, { launcher: async (u) => { calls.push(u); } });
    assert.equal(calls[0], url, 'URL must not be truncated at &');
  });

  it('reports verbatim-arguments need for win32 only', () => {
    assert.equal(_needsVerbatim('win32'), true);
    assert.equal(_needsVerbatim('darwin'), false);
    assert.equal(_needsVerbatim('linux'), false);
  });
});
