# Abilities MCP

> One MCP to Rule Your WordPress World.

**v1.0.0** — Renamed from WP Abilities MCP. Unified multi-site bridge with batch coalescing and HTTP transport.

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

### 1. Set up WordPress

Create a dedicated WordPress user for AI access and generate an Application Password.

**In WordPress Admin → Users → Add New:**

| Field | Value |
|-------|-------|
| Username | `mcp-agent` (or any name you prefer) |
| Role | **Administrator** for full access, or **Editor** for content-only access |

**Then generate an Application Password:**

Go to **Users → Edit (your mcp-agent user) → Application Passwords**, enter a name (e.g. "MCP Bridge"), and click **Add New Application Password**. Copy the generated password — it's shown only once.

#### Choosing a role

The AI agent's capabilities are determined by the WordPress role you assign. Every ability enforces `current_user_can()` at execution time — the role is your security boundary.

| Role | Modules accessible | Use case |
|------|-------------------|----------|
| **Administrator** | All 18 modules (138 abilities) | Full site management — content, plugins, themes, settings, users, cache, cron, filesystem |
| **Editor** | Content, Blocks, Taxonomies, Patterns, Meta, Media (6 modules) | Content publishing workflows — safe for teams where AI should write but not configure |

> **Tip:** Start with Editor. Upgrade to Administrator when you need infrastructure abilities like plugin management, theme switching, or settings changes.

#### Required plugins

Install both on your WordPress site:

1. **[Abilities for AI](https://github.com/Wicked-Evolutions/abilities-for-ai)** — registers 138 abilities
2. **[Abilities MCP Adapter](https://github.com/Wicked-Evolutions/abilities-mcp-adapter)** — exposes abilities as MCP tools via REST API

### 2. Configure your sites

Copy the example config and edit:

```bash
cp wp-sites.example.json wp-sites.json
```

Edit `wp-sites.json` with your site details.

### 2. Add to your MCP client

Works with any MCP-compatible client — Claude Code, Claude Desktop, Gemini CLI, Cursor, Windsurf, VS Code, and any other IDE or AI tool that supports the Model Context Protocol.

Add the server to your client's MCP config (usually `.mcp.json`, `settings.json`, or equivalent):

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "node",
      "args": ["/path/to/abilities-mcp/abilities-mcp.js"]
    }
  }
}
```

| Client | Config location |
|--------|----------------|
| Claude Code | `.mcp.json` in project root or `~/.claude/.mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (or use `--register`) |
| Gemini CLI | `~/.gemini/settings.json` |
| Cursor | `.cursor/mcp.json` in project root |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | `.vscode/mcp.json` in project root |

For Claude Desktop, you can also auto-register:

```bash
node abilities-mcp.js --register
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
2. Same directory as `abilities-mcp.js`
3. `~/.abilities-mcp/wp-sites.json`

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

Three options for providing Application Passwords to HTTP transport, from most to least secure:

#### `passwordCommand` (recommended)

Runs a shell command at startup and uses stdout as the password. Works with any OS keychain or secrets manager:

```json
{
  "http": {
    "endpoint": "https://example.com/wp-json/mcp/mcp-adapter-default-server",
    "username": "mcp-agent",
    "passwordCommand": "security find-generic-password -a mcp-agent -s example.com -w"
  }
}
```

**macOS Keychain** — store the password first, then reference it:

```bash
# Store (one-time)
security add-generic-password -a mcp-agent -s example.com -w 'YOUR_APP_PASSWORD'

# The passwordCommand retrieves it at runtime
"passwordCommand": "security find-generic-password -a mcp-agent -s example.com -w"
```

**Linux (secret-tool / GNOME Keyring):**

```bash
# Store
secret-tool store --label="WP MCP" service example.com user mcp-agent <<< 'YOUR_APP_PASSWORD'

# Config
"passwordCommand": "secret-tool lookup service example.com user mcp-agent"
```

**1Password CLI:**

```bash
"passwordCommand": "op read 'op://Vault/WordPress MCP/password'"
```

#### `passwordEnv`

Reads the password from an environment variable. Useful in CI/CD, Docker, or when you set secrets via `.env` files:

```json
{
  "http": {
    "endpoint": "https://example.com/wp-json/mcp/mcp-adapter-default-server",
    "username": "mcp-agent",
    "passwordEnv": "WP_MCP_PASSWORD"
  }
}
```

Set the variable before starting the bridge:

```bash
# Shell export
export WP_MCP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"

# Or in a .env file loaded by your shell/Docker
WP_MCP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
```

The bridge reads `process.env.WP_MCP_PASSWORD` at connection time. If the variable is not set, it throws an error immediately.

#### `password` (not recommended)

Plaintext password directly in the config. Avoid this — config files end up in repos, backups, and logs:

```json
{
  "http": {
    "password": "xxxx xxxx xxxx xxxx xxxx xxxx"
  }
}
```

#### Priority order

If multiple are set: `passwordEnv` → `passwordCommand` → `password`.

## Bridge Tools

The bridge provides three built-in tools (not forwarded to WordPress):

| Tool | Description |
|------|-------------|
| `wp_bridge_health` | Check connectivity status of all configured WordPress sites |
| `wp_browse_tools` | List WordPress tool categories with counts (requires `toolFilter.enabled: true`) |
| `wp_load_tools` | Activate/deactivate tool categories for lazy loading |

## Known Limitations

- **Session lock contention** ([#4](https://github.com/Wicked-Evolutions/abilities-mcp/issues/4)) — Concurrent bridge instances targeting the same site can cause session loss. Use a single bridge process per site.
- **SSH transport: stale processes on hosting** — SSH transport spawns `wp mcp-adapter serve` processes on the remote server. If connections aren't cleanly terminated (client crash, network drop, force-quit), these processes can remain running and accumulate memory usage on the hosting server over time. The bridge attempts cleanup via `pkill -f` on reconnect, but the pattern matching is broad. **HTTP transport does not have this issue** — each request is stateless. If you use SSH transport, monitor your hosting for orphaned PHP processes. Contributions welcome: [#6](https://github.com/Wicked-Evolutions/abilities-mcp/issues/6).
- ~~**Multisite blog_id switching** ([#3](https://github.com/Wicked-Evolutions/abilities-mcp/issues/3))~~ — **Fixed.** Subsite content queries now correctly switch blog context.
- ~~**Tool registration** ([#5](https://github.com/Wicked-Evolutions/abilities-mcp/issues/5))~~ — **Fixed.** Root cause was `annotations` field and `protocolVersion` mismatch. The sanitizer now preserves MCP-compliant annotations (permission hints, enabled state) and strips non-standard fields.

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
node abilities-mcp.js --host=my-ssh-host --path=~/public_html --user=wpaiagent
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
| `--debug` | Enable debug logging to `/tmp/abilities-mcp.log` |
| `--register` | Register in Claude Desktop config |
| `--name=<name>` | Server name for `--register` (default: `wordpress`) |

## Architecture

```
Claude Code / Claude Desktop (STDIO)
              |
       abilities-mcp.js
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
- WordPress sites with [Abilities for AI](https://github.com/Wicked-Evolutions/abilities-for-ai) (138 abilities across 18 modules) and [Abilities MCP Adapter](https://github.com/Wicked-Evolutions/abilities-mcp-adapter) installed
- SSH access (for SSH transport) or Application Passwords (for HTTP transport)

## License

GPL-2.0-or-later
