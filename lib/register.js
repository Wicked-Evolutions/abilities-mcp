'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Register wp-abilities-mcp as a server in Claude Desktop's config.
 *
 * @param {object} opts
 * @param {string} [opts.name='wordpress'] - Server name in config
 * @param {string} [opts.configPath]       - Explicit wp-sites.json path
 */
function registerClaudeDesktop(opts = {}) {
  const name = opts.name || 'wordpress';

  // Determine Claude Desktop config path per platform
  let configDir;
  if (process.platform === 'darwin') {
    configDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  } else if (process.platform === 'win32') {
    configDir = path.join(process.env.APPDATA || '', 'Claude');
  } else {
    configDir = path.join(os.homedir(), '.config', 'claude');
  }

  const configPath = path.join(configDir, 'claude_desktop_config.json');
  const bridgePath = path.resolve(path.join(__dirname, '..', 'wp-abilities-mcp.js'));

  // Build server entry
  const entryArgs = [bridgePath];
  if (opts.configPath) {
    entryArgs.push(`--config=${opts.configPath}`);
  }

  const entry = {
    command: 'node',
    args: entryArgs,
  };

  // Read or create config
  let config = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch (e) {
      process.stderr.write(`Warning: could not parse ${configPath}, creating new config\n`);
      config = { mcpServers: {} };
    }
  } else {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existed = !!config.mcpServers[name];
  config.mcpServers[name] = entry;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  process.stderr.write(`${existed ? 'Updated' : 'Added'} MCP server "${name}" in ${configPath}\n`);
}

module.exports = { registerClaudeDesktop };
