'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../lib/config');
const {
  formatConfigSourceLine,
  tildify,
  siteAuthLabel,
} = require('../lib/config-source-line');
const { makeTempHome } = require('./helpers/temp-home');

/**
 * Issue #32 — Phase B of the v1.5.2 sprint.
 *
 * Pins the `_configSource` / `_configSourceLabel` discriminants emitted by
 * every `loadConfig` branch, plus the formatter that turns them into the
 * single operator-visible startup line on stderr.
 */

const tmpFiles = [];
after(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

function writeTempConfig(contents) {
  const file = path.join(
    os.tmpdir(),
    `wp-sites.test.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 });
  tmpFiles.push(file);
  return file;
}

const APPPASSWORD_HTTP_SITE = {
  defaultSite: 'siteA',
  sites: {
    siteA: {
      url: 'https://example.com',
      transport: 'http',
      http: {
        endpoint: 'https://example.com/wp-json/mcp/abilities-mcp-adapter-default-server',
        username: 'wp_user',
        password: 'pw',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// loadConfig _configSource pinning — one assertion per branch.
// ---------------------------------------------------------------------------

describe('loadConfig — _configSource discriminant per branch (Issue #32)', () => {
  it('explicit-config: args.config sets _configSource and _configSourceLabel', async () => {
    const file = writeTempConfig(APPPASSWORD_HTTP_SITE);
    const cfg = await loadConfig({ config: file });
    assert.equal(cfg._configSource, 'explicit-config');
    assert.equal(cfg._configSourceLabel, file);
    assert.equal(cfg._configPath, file);
  });

  it('home-dir: ~/.abilities-mcp/wp-sites.json is picked up with home-dir discriminant', async () => {
    const home = makeTempHome();
    const homeConfigDir = path.join(home.dir, '.abilities-mcp');
    fs.mkdirSync(homeConfigDir, { recursive: true });
    const homeConfigFile = path.join(homeConfigDir, 'wp-sites.json');
    fs.writeFileSync(homeConfigFile, JSON.stringify(APPPASSWORD_HTTP_SITE, null, 2), { mode: 0o600 });

    try {
      // The script-adjacent path takes precedence over home-dir — skip if the repo
      // happens to carry a script-adjacent wp-sites.json (dev machines often do).
      const scriptAdjacent = path.resolve(__dirname, '..', 'wp-sites.json');
      if (fs.existsSync(scriptAdjacent)) {
        return;
      }
      const cfg = await loadConfig({});
      assert.equal(cfg._configSource, 'home-dir');
      assert.equal(cfg._configSourceLabel, homeConfigFile);
    } finally {
      home.restore();
    }
  });

  it('env-var: ABILITIES_MCP_URL sets _configSource=env-var and label is hostname', async () => {
    const origUrl = process.env.ABILITIES_MCP_URL;
    const origUser = process.env.ABILITIES_MCP_USERNAME;
    const origPass = process.env.ABILITIES_MCP_PASSWORD;

    const home = makeTempHome();
    process.env.ABILITIES_MCP_URL = 'https://wickedevolutions.com';
    process.env.ABILITIES_MCP_USERNAME = 'wicked';
    process.env.ABILITIES_MCP_PASSWORD = 'app-pw';

    try {
      const scriptAdjacent = path.resolve(__dirname, '..', 'wp-sites.json');
      if (fs.existsSync(scriptAdjacent)) return;
      const cfg = await loadConfig({});
      assert.equal(cfg._configSource, 'env-var');
      assert.equal(cfg._configSourceLabel, 'wickedevolutions.com');
    } finally {
      home.restore();
      if (origUrl === undefined) delete process.env.ABILITIES_MCP_URL; else process.env.ABILITIES_MCP_URL = origUrl;
      if (origUser === undefined) delete process.env.ABILITIES_MCP_USERNAME; else process.env.ABILITIES_MCP_USERNAME = origUser;
      if (origPass === undefined) delete process.env.ABILITIES_MCP_PASSWORD; else process.env.ABILITIES_MCP_PASSWORD = origPass;
    }
  });

  it('legacy-cli: --host / --path sets _configSource=legacy-cli and label is host', async () => {
    const origUrl = process.env.ABILITIES_MCP_URL;
    delete process.env.ABILITIES_MCP_URL;
    const home = makeTempHome();
    try {
      const scriptAdjacent = path.resolve(__dirname, '..', 'wp-sites.json');
      if (fs.existsSync(scriptAdjacent)) return;
      const cfg = await loadConfig({ host: 'legacy.example', path: '/var/www/wp' });
      assert.equal(cfg._configSource, 'legacy-cli');
      assert.equal(cfg._configSourceLabel, 'legacy.example');
    } finally {
      home.restore();
      if (origUrl !== undefined) process.env.ABILITIES_MCP_URL = origUrl;
    }
  });
});

// ---------------------------------------------------------------------------
// Formatter — every source produces a sensible operator-visible line.
// ---------------------------------------------------------------------------

describe('formatConfigSourceLine — per-source output format', () => {
  it('formats env-var single-site basic auth', () => {
    const line = formatConfigSourceLine({
      _configSource: 'env-var',
      _configSourceLabel: 'wickedevolutions.com',
      defaultSite: 'default',
      sites: {
        default: {
          transport: 'http',
          http: { endpoint: 'https://wickedevolutions.com/wp-json/mcp/abilities-mcp-adapter-default-server', username: 'wicked', password: 'pw' },
        },
      },
    });
    assert.match(line, /^Config source: ABILITIES_MCP_URL env var/);
    assert.match(line, /wickedevolutions\.com/);
    assert.match(line, /as wicked/);
  });

  it('formats legacy-cli single-site SSH', () => {
    const line = formatConfigSourceLine({
      _configSource: 'legacy-cli',
      _configSourceLabel: 'legacy.example',
      defaultSite: 'default',
      sites: { default: { transport: 'ssh', ssh: { host: 'legacy.example', path: '/var/www/wp' } } },
    });
    assert.match(line, /^Config source: --host\/--path legacy CLI/);
    assert.match(line, /legacy\.example/);
  });

  it('formats home-dir multi-site with per-site auth methods', () => {
    const fakeFile = path.join(os.homedir(), '.abilities-mcp', 'wp-sites.json');
    const line = formatConfigSourceLine({
      _configSource: 'home-dir',
      _configSourceLabel: fakeFile,
      defaultSite: 'helena',
      sites: {
        helena: { url: 'https://helenawillow.com', auth: { method: 'oauth' } },
        wicked: { url: 'https://wickedevolutions.com', auth: { method: 'oauth' } },
        legacy: { url: 'https://legacy.example', transport: 'http', http: {} },
      },
    });
    assert.match(line, /^Config source: \[home-dir\]/);
    assert.match(line, /~[\\/]\.abilities-mcp[\\/]wp-sites\.json/);
    assert.match(line, /3 sites:/);
    assert.match(line, /helena oauth/);
    assert.match(line, /wicked oauth/);
    assert.match(line, /legacy http/);
  });

  it('formats explicit-config single-site (1 site, not 1 sites)', () => {
    const line = formatConfigSourceLine({
      _configSource: 'explicit-config',
      _configSourceLabel: '/tmp/wp-sites.json',
      defaultSite: 'siteA',
      sites: { siteA: { auth: { method: 'apppassword' } } },
    });
    assert.match(line, /^Config source: \[explicit-config\] \/tmp\/wp-sites\.json/);
    assert.match(line, /\(1 site: siteA apppassword\)/);
  });

  it('formats script-adjacent the same shape as home-dir but with a different prefix', () => {
    const line = formatConfigSourceLine({
      _configSource: 'script-adjacent',
      _configSourceLabel: '/abs/path/wp-sites.json',
      defaultSite: 'siteA',
      sites: { siteA: { auth: { method: 'oauth' } } },
    });
    assert.match(line, /^Config source: \[script-adjacent\]/);
    assert.match(line, /siteA oauth/);
  });
});

describe('tildify', () => {
  it('replaces leading $HOME with ~', () => {
    const home = os.homedir();
    assert.equal(tildify(`${home}/foo/bar`), '~/foo/bar');
    assert.equal(tildify(home), '~');
  });

  it('replaces leading $HOME using the platform separator (win32 backslash)', () => {
    const home = os.homedir();
    assert.equal(
      tildify(home + path.sep + 'foo' + path.sep + 'bar'),
      '~' + path.sep + 'foo' + path.sep + 'bar'
    );
  });

  it('leaves paths outside $HOME untouched', () => {
    assert.equal(tildify('/tmp/foo'), '/tmp/foo');
    assert.equal(tildify('/etc/passwd'), '/etc/passwd');
  });

  it('handles empty / null input', () => {
    assert.equal(tildify(''), '');
    assert.equal(tildify(null), null);
  });
});

describe('siteAuthLabel', () => {
  it('prefers auth.method when present (v2 schema)', () => {
    assert.equal(siteAuthLabel({ auth: { method: 'oauth' }, transport: 'http' }), 'oauth');
    assert.equal(siteAuthLabel({ auth: { method: 'apppassword' }, transport: 'ssh' }), 'apppassword');
  });

  it('falls back to transport when no auth block (v1 schema)', () => {
    assert.equal(siteAuthLabel({ transport: 'ssh' }), 'ssh');
    assert.equal(siteAuthLabel({ transport: 'http' }), 'http');
  });

  it('returns "unknown" when neither auth.method nor transport is set', () => {
    assert.equal(siteAuthLabel({}), 'unknown');
    assert.equal(siteAuthLabel(null), 'unknown');
  });
});
