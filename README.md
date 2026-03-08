# wp-abilities-mcp

> One MCP to Rule Your WordPress World.

Unified multi-site MCP bridge for WordPress Abilities API. Replaces separate per-site bridge instances with a single STDIO server that routes tool calls to any configured WordPress site via SSH or HTTP.

## Features

- **Multi-site routing** — Single MCP server serves all your WordPress sites
- **Site parameter injection** — LLM sees a `site` enum on every tool, defaults to your primary site
- **Lazy connections** — Sites connect on first use, not at startup
- **HTTP transport (primary)** — HTTP via Application Passwords with session management
- **SSH transport (legacy)** — SSH via WP-CLI, kept for backward compatibility
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
  "defaultSite": "mysite",
  "sites": {
    "mysite": {
      "label": "My WordPress Site",
      "url": "https://example.com",
      "transport": "http",
      "http": {
        "endpoint": "https://example.com/wp-json/mcp/mcp-adapter-default-server",
        "username": "mcp-agent",
        "passwordCommand": "security find-generic-password -a mcp-agent -s example.com -w"
      }
    },
    "legacy-ssh": {
      "label": "SSH Site (legacy)",
      "transport": "ssh",
      "ssh": {
        "host": "my-ssh-host",
        "path": "~/public_html",
        "user": "wpaiagent"
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

### Secure password storage

Instead of plaintext passwords, use `passwordCommand` to read from your OS keychain:

```json
{
  "transport": "http",
  "http": {
    "endpoint": "https://example.com/wp-json/mcp/mcp-adapter-default-server",
    "username": "mcp-agent",
    "passwordCommand": "security find-generic-password -a mcp-agent -s example.com -w"
  }
}
```

Also supported: `passwordEnv` to read from an environment variable.

## Bridge Tools

The bridge provides three built-in tools (not forwarded to WordPress):

| Tool | Description |
|------|-------------|
| `wp_bridge_health` | Check connectivity status of all configured WordPress sites |
| `wp_browse_tools` | List WordPress tool categories with counts (requires `toolFilter.enabled: true`) |
| `wp_load_tools` | Activate/deactivate tool categories for lazy loading |

## Known Limitations

- **Session lock contention** ([#4](https://github.com/Influencentricity/wp-abilities-mcp/issues/4)) — Concurrent bridge instances targeting the same site can cause session loss. Use a single bridge process per site.
- ~~**Multisite blog_id switching** ([#3](https://github.com/Influencentricity/wp-abilities-mcp/issues/3))~~ — **Fixed.** Subsite content queries now correctly switch blog context.
- ~~**Tool registration** ([#5](https://github.com/Influencentricity/wp-abilities-mcp/issues/5))~~ — **Fixed.** Root cause was `annotations` field and `protocolVersion` mismatch. The sanitizer now preserves MCP-compliant annotations (permission hints, enabled state) and strips non-standard fields.

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
Claude Code / Claude Desktop (STDIO)
              |
       wp-abilities-mcp.js
         |          |
    Connection Pool + Tool Catalog
         |          |           |
      helena      wicked   wicked.community
      (HTTP)      (HTTP)   (HTTP + blog_id)
```

- One STDIO process handles all sites
- HTTP transport is primary (Application Passwords + MCP session management)
- SSH transport is legacy (WP-CLI over SSH, kept for backward compatibility)
- Connection pool lazily spawns transports per site
- MCP handshake is replayed to new connections mid-session
- Tool list comes from the default site with `site` enum injected
- Permission metadata (`permission`, `enabled`) flows through annotations to the LLM

## Requirements

- Node.js >= 18
- WordPress sites with [Abilities Suite for WordPress](https://github.com/Influencentricity/abilities-suite-for-wordpress) and [MCP Adapter for WordPress](https://github.com/Influencentricity/mcp-adapter-for-wordpress) installed
- SSH access (for SSH transport) or Application Passwords (for HTTP transport)

## License

GPL-2.0-or-later
