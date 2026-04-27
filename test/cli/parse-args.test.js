'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../../lib/cli/parse-args');

describe('CLI arg parser', () => {
  it('captures positional args', () => {
    const r = parse(['site-a', 'site-b']);
    assert.deepEqual(r._, ['site-a', 'site-b']);
  });

  it('parses --key=value', () => {
    const r = parse(['add-site', '--site-id=siteA', '--label=Example']);
    assert.deepEqual(r._, ['add-site']);
    assert.equal(r['site-id'], 'siteA');
    assert.equal(r.label, 'Example');
  });

  it('parses --key value', () => {
    const r = parse(['--username', 'wp_agent', '--password', 'abcd 1234']);
    assert.equal(r.username, 'wp_agent');
    assert.equal(r.password, 'abcd 1234');
  });

  it('treats boolean flags as true even when followed by another flag', () => {
    const r = parse(['--apppassword', '--username=u']);
    assert.equal(r.apppassword, true);
    assert.equal(r.username, 'u');
  });

  it('coerces literal "true"/"false"', () => {
    const r = parse(['--scope=read', '--allow-insecure=true']);
    assert.equal(r.scope, 'read');
    assert.equal(r['allow-insecure'], true);
  });

  it('treats tokens after -- as positionals', () => {
    const r = parse(['cmd', '--', '--not-a-flag', '-x']);
    assert.deepEqual(r._, ['cmd', '--not-a-flag', '-x']);
  });
});
