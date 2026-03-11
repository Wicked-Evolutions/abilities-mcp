# ROADMAP — WP Abilities MCP

> Source of truth for product development state. Obsidian roadmap references this file.
> Part of the Wicked Evolutions Trinity AI Suite for WordPress.

**Current version:** v1.2.0
**Health:** Strong — multi-session stable, cookie jar, session recovery, batch coalescing

---

## Open Bugs

| Bug | Priority | Notes |
|-----|----------|-------|
| ~~Entry file version comment stale~~ | ~~Low~~ | **FIXED** — updated to v1.2.0. |
| Bug 4: per-client handshake cache | Medium | Handshake cache is global/shared, not per-client. If multiple clients connect simultaneously, they share the same handshake. Deferred to Phase B (McpRouter extraction). |
| SSH `pkill -f` pattern matching | Low | Uses broad `.*` wildcards in kill pattern. Could match unintended processes. SSH is legacy transport. |

## Gaps

| Gap | Priority | Notes |
|-----|----------|-------|
| ~~`files` field missing in package.json~~ | ~~Low~~ | **FIXED** — added explicit file list for clean npm publish. |
| ~~Schema validation errors silently dropped~~ | ~~Medium~~ | **FIXED** — `validateToolSchema()` logs warnings for invalid types, missing `items` on arrays, malformed properties. Debug log only (tools still pass through). |
| No automated tests | Medium | All verification is manual. Fragile for regression detection. |
| SSH transport undocumented deprecation | Low | Decision made (HTTP-primary) but no warning logged when SSH selected. |
| Tool filtering disabled in production | Low | Feature coded and working but `enabled: false` in wp-sites.json. Could mitigate tool count issues if enabled. |

## Not Started

| Item | Priority | Notes |
|------|----------|-------|
| Phase B: McpRouter extraction | Medium | Per-client handshake cache, SSH cleanup. Architectural refactor. **Risk: if handshake replay breaks, non-default sites stop working.** |
| npm publish v1.2.0 | Low | `npm pack` works. Blocked on Phase B decision. |
| SSH deprecation warning | Low | Add `log.warn()` in ssh-transport.js constructor. |
| ~~Improve schema validation error reporting~~ | ~~Medium~~ | **DONE** — `validateToolSchema()` in sanitizer.js surfaces schema issues in debug log. |

## Recently Completed

| Item | Version | Date |
|------|---------|------|
| GPL-2.0 compliance (LICENSE, headers, copyright) | — | 2026-03-11 |
| WordPress setup guide with role-based access | — | 2026-03-11 |
| Unified MCP client setup with config table | — | 2026-03-11 |
| Password how-to (passwordCommand/passwordEnv/password) | — | 2026-03-11 |
| `.nvmrc` (Node 20) | — | exists |
| JSON-RPC batch coalescing (10ms window) | v1.2.0 | 2026-03-09 |
| Integer overflow fix in synthetic handshake IDs | v1.2.0 | 2026-03-09 |
| Per-host cookie jar | v1.2.0 | 2026-03-09 |
| Session recovery (401/403) | v1.2.0 | 2026-03-09 |
| Router extraction + sanitizer whitelist + 44 tests | v1.1.0 | 2026-03-08 |
| Multi-site routing with site parameter injection | v1.0.0 | 2026-03-05 |
| Tool registration fix (#5) | v1.0.0 | 2026-03-05 |
| Multisite blog_id switching (#3) | v1.0.0 | 2026-03-05 |

## False Alarms (verified 2026-03-11)

- ~~`.nvmrc` missing~~ — Exists, specifies Node 20.
