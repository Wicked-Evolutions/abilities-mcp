'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { openBrowser, _commandFor } = require('../../lib/auth/browser-launcher');

describe('browser-launcher', () => {
  it('selects the right command per platform', () => {
    assert.deepEqual(_commandFor('darwin'), { cmd: 'open', args: [] });
    assert.deepEqual(_commandFor('win32'), { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler'] });
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

  it('passes URL with &, ?, =, and %XX intact as a single win32 spawn argument', async () => {
    const url = 'https://example.com/oauth/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fcallback%3Fstate%3Dxyz%26scope%3Dread';
    let spawnCall = null;
    const fakeChild = {
      on: () => {},
      unref: () => {},
    };
    const result = await openBrowser(url, {
      platform: 'win32',
      spawner: (cmd, args, spawnOpts) => {
        spawnCall = { cmd, args, spawnOpts };
        return fakeChild;
      },
    });

    assert.equal(result.spawned, true);
    assert.equal(result.platform, 'win32');
    assert.equal(spawnCall.cmd, 'rundll32.exe');
    assert.deepEqual(spawnCall.args, ['url.dll,FileProtocolHandler', url]);
    assert.equal(spawnCall.args[1], url, 'URL must not be mutated or truncated at & or %');
    assert.equal(spawnCall.spawnOpts.windowsVerbatimArguments, undefined, 'no-shell launcher does not need windowsVerbatimArguments');
  });
});
