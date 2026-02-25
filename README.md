# wp-abilities-mcp

> One MCP to Rule Your WordPress World.

Unified multi-site MCP bridge for WordPress Abilities API. Replaces separate per-site bridge instances with a single STDIO server that routes tool calls to any configured WordPress site via SSH or HTTP.

## Features

- **Multi-site routing** — Single MCP server serves all your WordPress sites
- **Site parameter injection** — LLM sees a `site` enum on every tool, defaults to your primary site
- **Lazy connections** — Sites connect on first use, not at startup
- **SSH + HTTP transports** — SSH via WP-CLI, HTTP via Application Passwords
- **WordPress multisite** — Subdomain/subdirectory multisites via dot notation (`wicked.community`)
- **Auto-reconnect** — Exponential backoff, healthcheck pings, session recovery
- **Zero dependencies** — Node.js built-in modules only
- **Backward compatible** — Drop-in replacement for mcp-ssh-bridge with `--host`/`--path` args

## Quick Start

### 1. Configure your sites

Copy the example config and edit:

```bash
cp wp-sites.example.json wp-sites.json
```

Edit `wp-sites.json` with your site details (SSH hosts, paths, users, or HTTP endpoints).

### 2. Add to Claude Code

In your `.mcp.json`:

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "node",
      "args": ["/path/to/wp-abilities-mcp/wp-abilities-mcp.js"]
    }
  }
}
```

### 3. Add to Claude Desktop

```bash
node wp-abilities-mcp.js --register
```

## Configuration

### `wp-sites.json`

```json
{
  "defaultSite": "helena",
  "sites": {
    "helena": {
      "label": "Helena Willow",
      "url": "https://helenawillow.com",
      "transport": "ssh",
      "ssh": {
        "host": "hostinger-web",
        "path": "~/domains/helenawillow.com/public_html",
        "user": "wp_ai_agent_editor_v01"
      }
    },
    "staging": {
      "transport": "http",
      "http": {
        "endpoint": "https://staging.example.com/wp-json/mcp/mcp-adapter-default-server",
        "username": "mcp-agent",
        "password": "xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

### Config file search order

1. `--config=/path/to/wp-sites.json` (explicit)
2. Same directory as `wp-abilities-mcp.js`
3. `~/.wp-abilities-mcp/wp-sites.json`

### WordPress Multisite

For WordPress multisites, add a `multisite` object mapping subsite keys to their URLs:

```json
{
  "wicked": {
    "transport": "ssh",
    "ssh": { "host": "my-host", "path": "~/public_html" },
    "multisite": {
      "main": "https://wickedevolutions.com/",
      "community": "https://community.wickedevolutions.com/"
    }
  }
}
```

Use dot notation to target subsites: `"site": "wicked.community"`

## Usage

### Multi-site mode

When multiple sites are configured, every tool gets an optional `site` parameter:

```json
{
  "name": "content-list",
  "arguments": {
    "site": "wicked",
    "post_type": "post"
  }
}
```

Omit `site` to use the default site.

### Legacy single-site mode

For backward compatibility with mcp-ssh-bridge:

```bash
node wp-abilities-mcp.js --host=my-ssh-host --path=~/public_html --user=wpaiagent
```

No `site` parameter is injected in this mode.

## CLI Options

| Flag | Description |
|------|-------------|
| `--config=<path>` | Path to wp-sites.json |
| `--host=<host>` | SSH host (legacy single-site mode) |
| `--path=<path>` | WordPress path (legacy single-site mode) |
| `--user=<user>` | SSH/WP-CLI user |
| `--server=<name>` | MCP adapter server name |
| `--debug` | Enable debug logging to `/tmp/wp-abilities-mcp.log` |
| `--register` | Register in Claude Desktop config |
| `--name=<name>` | Server name for `--register` (default: `wordpress`) |

## Architecture

```
Claude Code (STDIO)
       |
  wp-abilities-mcp.js
       |
  +----+----+----------------+
  |         |                |
helena    wicked    wicked.community
(SSH)     (SSH)     (SSH + --url=)
```

- One STDIO process handles all sites
- Connection pool lazily spawns transports per site
- MCP handshake is replayed to new connections mid-session
- Tool list comes from the default site with `site` enum injected

## Requirements

- Node.js >= 18
- WordPress sites with [Abilities Suite](https://github.com/flavflavor) and [MCP Adapter](https://github.com/flavor) installed
- SSH access (for SSH transport) or Application Passwords (for HTTP transport)

## License

GPL-2.0-or-later
