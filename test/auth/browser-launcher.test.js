'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { openBrowser, _commandFor } = require('../../lib/auth/browser-launcher');

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
});
