# Changelog

All notable changes to Abilities MCP are documented here.

## [Unreleased]

### Added
- **Phase 5 OAuth CLI surface** (#13). `abilities-mcp <subcommand>` dispatches to nine new subcommands wrapping the Phase 4 `lib/auth/` module: `add-site`, `reauth`, `revoke`, `list-sites`, `test`, `upgrade-auth`, `force-downgrade` (Appendix H.2.3), `self-check` (Appendix H.2.6), `clear-keychain` (Appendix H.3.2). Each subcommand subscribes to the OAuth state machine and prints operator-facing progress lines. Error messages name the exact next action. Bare `node abilities-mcp.js` (no subcommand) still starts the MCP STDIO server unchanged.
- Exit-code table (`0`/`1`/`2`/`3`/`4`/`5`) mapping success / generic / usage / config / auth / capability-pinning failures, documented in `abilities-mcp --help`.
- `--debug` flag includes the `cause` stack on errors for troubleshooting.
- `force-downgrade` audit lives on the site config (`force_downgrade.{at, expires_at, reason}`) and is surfaced in `list-sites` for 30 days.

## [1.4.0] - 2026-04-26

### Added
- `.mcpb` distribution bundle for one-click install in Claude Desktop (#8). `manifest.json` against MCPB spec v0.3, `.mcpbignore`, and `npm run pack:mcpb` script. Application Password is stored encrypted in the OS keychain via `sensitive: true`. Published as a GitHub Release asset.
- `ABILITIES_MCP_URL` / `ABILITIES_MCP_USERNAME` / `ABILITIES_MCP_PASSWORD` environment-variable config fallback in `lib/config.js`. When no `wp-sites.json` exists, the bridge builds a single-site config from the env vars and auto-derives the MCP adapter endpoint as `<URL>/wp-json/mcp/mcp-adapter-default-server`. Covers the `.mcpb` install path and any env-var-based MCP client (`claude mcp add`, Docker, etc.).
- `npm run validate:mcpb` — validates `manifest.json` against the MCPB schema.

### Changed
- README restructured around three install paths: `.mcpb` bundle (recommended for Claude Desktop), env-vars + npm install (Claude Code / Cursor / Docker), and `wp-sites.json` (multi-site / power users). Existing `wp-sites.json` users are unaffected.

## [1.3.1] - 2026-03-19

### Fixed
- Convert execute-ability error payloads to `isError` format — fold `input_schema` into error text for AI self-correction (#2)
- Convert JSON-RPC error objects to `isError` format for client visibility (#4)

### Changed
- Remove protocol version rewriting from both transports — Adapter now handles MCP version negotiation natively

## [1.3.0] - 2026-03-11

### Added
- Schema validation warnings in sanitizer — logs when WordPress responses contain non-standard fields
- Architecture documentation (`docs/architecture.md`)

### Changed
- Renamed from WP Abilities MCP to **Abilities MCP**
- Package name: `@wicked-evolutions/abilities-mcp`
- Entry point: `abilities-mcp.js`
- GPL-2.0 compliance headers on all source files
- Repo cleanup: removed ROADMAP (GitHub project board is the authority), fixed stale references

## [1.2.0] - 2026-03-09

### Added
- JSON-RPC batch coalescing in `HttpTransport._drainQueue()` — 10ms window accumulates concurrent messages and dispatches as a single JSON-RPC batch POST. Reduces N round-trips to 1 for concurrent multi-agent workloads. Sequential single-agent sessions are unaffected.

### Fixed
- Fix integer overflow in synthetic handshake IDs — replace `Date.now()` with incrementing counter; 13-digit ms timestamps exceed 32-bit int max, causing `TypeError` in PHP `strict_types=1` environments
- Fix missing cookie support in HTTP transport — add per-host cookie jar; parse `Set-Cookie` response headers and send `Cookie` on subsequent requests so PHP native sessions aren't dropped between requests
- Fix incomplete session recovery — extend re-handshake trigger to include HTTP 401/403 when an active session exists; some WordPress configs return these for stale session tokens rather than 404/410

## [1.1.0] - 2026-03-08

### Added
- Permission metadata passthrough — sanitizer preserves `permission` and `enabled` annotation fields from MCP Adapter
- `[DISABLED]` label injection — tools with `enabled: false` get description suffix showing required permission level
- Annotation whitelisting — keeps MCP-compliant fields (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`, `permission`, `enabled`), strips non-standard fields
- Automated test suite using `node:test` (18 sanitizer tests)

### Fixed
- Fix multisite blog_id not switching for subsite queries — build per-subsite endpoint URLs so WordPress boots into the correct blog context natively (#3)
- Fix tool registration failure in Claude Code — strip non-standard annotation fields while preserving MCP-compliant ones (#5)
- Fix HTTP multisite session loss — reuse existing transport for same-endpoint subsites instead of creating competing connections (#1, PR #2)

## [1.0.0] - 2026-02-26

### Added
- Unified multi-site MCP bridge
- HTTP transport with session management (Mcp-Session-Id/Token headers)
- SSH transport with auto-reconnect, exponential backoff, and healthcheck pings
- Multi-site routing with `site` parameter injection on all tools
- Lazy connections — non-default sites connect on first tool call
- MCP handshake replay for mid-session connections
- WordPress multisite support via dot notation
- `wp-sites.json` configuration with config file search order
- `passwordCommand` and `passwordEnv` for secure credential storage
- Claude Desktop registration (`--register` flag)
- Debug logging (`--debug` flag)
- Zero dependencies — Node.js built-in modules only
- `wp_bridge_health` — check connectivity status of all configured sites
- `wp_browse_tools` / `wp_load_tools` — category-based lazy tool loading
- GitHub infrastructure: issue templates, PR template, Actions workflow

### Security
- Security audit — 9 findings, all fixed
- Session token forwarding (Mcp-Session-Token header)
- Schema sanitization (strips non-standard fields from tool definitions)

### Known Issues
- Session lock contention with concurrent bridge instances (#4) — server-side MySQL GET_LOCK fix deployed, bridge-side auto-recovery adds ~200ms latency

---

## License

GPL-2.0-or-later
