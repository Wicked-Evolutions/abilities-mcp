# Changelog

## [1.0.0] - 2026-02-26

### Added
- Unified multi-site MCP bridge replacing mcp-ssh-bridge and mcp-http-bridge
- SSH transport with auto-reconnect, exponential backoff, and healthcheck pings
- HTTP transport with session management (Mcp-Session-Id/Token headers)
- Multi-site routing with `site` parameter injection on all tools
- Lazy connections — non-default sites connect on first tool call
- MCP handshake replay for mid-session connections
- WordPress multisite support via dot notation (`wicked.community`)
- `wp-sites.json` configuration with config file search order
- `passwordCommand` and `passwordEnv` for secure credential storage
- Legacy single-site mode (`--host`/`--path`/`--user` flags)
- Claude Desktop registration (`--register` flag)
- Debug logging (`--debug` flag)
- Zero dependencies — Node.js built-in modules only

### Security (GPT-5.2 Pro review — 9 findings, all fixed)
- Session token forwarding (Mcp-Session-Token header)
- Schema sanitization (strips non-standard `type` and `outputSchema` fields)

### Added (post-release)
- `wp_bridge_health` — check connectivity status of all configured sites
- `wp_browse_tools` / `wp_load_tools` — category-based lazy tool loading
- GitHub infrastructure: issue templates, PR template, Actions workflow

### Known Issues
- Multisite blog_id not switching for subsite content queries (#3)
- Tool registration failure in some configurations (#5)

---

## License

GPL-2.0-or-later
