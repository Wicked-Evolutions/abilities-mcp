# Changelog

## [1.1.0] - 2026-03-08

### Added
- Permission metadata passthrough — sanitizer preserves `permission` and `enabled` annotation fields from MCP Adapter
- `[DISABLED]` label injection — tools with `enabled: false` get description suffix showing required permission level
- Annotation whitelisting — keeps MCP-compliant fields (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`, `permission`, `enabled`), strips non-standard fields
- Automated test suite using `node:test` (18 sanitizer tests)
- `.npmignore` for clean package publishing
- `.nvmrc` targeting Node 20
- `npm test` script in package.json

### Fixed
- Fix multisite blog_id not switching for subsite queries — build per-subsite endpoint URLs so WordPress boots into the correct blog context natively (#3)
- Fix tool registration failure in Claude Code — strip non-standard annotation fields while preserving MCP-compliant ones (#5)
- Fix HTTP multisite session loss — reuse existing transport for same-endpoint subsites instead of creating competing connections (#1, PR #2)

### Changed
- README updated: architecture diagram shows HTTP as primary transport, SSH marked as legacy
- Example config (`wp-sites.example.json`) defaults to HTTP with `passwordCommand`
- Manual test files moved to `test/manual/`

### Known Issues
- Session lock contention with concurrent bridge instances (#4) — server-side MySQL GET_LOCK fix deployed, bridge-side auto-recovery adds ~200ms latency

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

---

## License

GPL-2.0-or-later
