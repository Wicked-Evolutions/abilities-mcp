# Changelog

All notable changes to Abilities MCP are documented here.

## [1.5.2] - 2026-05-03

**OAuth flow now works inside `.mcpb`.** This release makes the documented `.mcpb` operator UX work end-to-end: install the extension from Claude Desktop with an Application Password, then run `abilities-mcp upgrade-auth <site>` from a terminal to migrate that single connection to OAuth in place, then `abilities-mcp add-site https://other.com` to add more sites — all surfacing through the same Claude Desktop "Abilities MCP" entry. Before this release, the keytar binary wasn't bundled with the `.mcpb` and the `.mcpb` install never persisted to `~/.abilities-mcp/wp-sites.json`, so the documented progression failed at the moment OAuth touched the keychain.

Bridge-only release — no companion adapter or ai release this sprint.

### Fixed

- **`.mcpb` bundle now ships keytar prebuilds for darwin x64, darwin arm64, win32 x64, and linux x64** (PR [#35](https://github.com/Wicked-Evolutions/abilities-mcp/pull/35), closes [#33](https://github.com/Wicked-Evolutions/abilities-mcp/issues/33)). Without these, `KeychainSecretStore` failed at first request with `Cannot find module 'keytar'` even on the host platform — verified empirically against the v1.5.1 bundle. The pack pipeline moves from a single-line `mcpb pack` invocation to a staging-directory build (`scripts/pack-mcpb.js`) that fetches each platform's prebuild via `prebuild-install` and patches keytar's hardcoded single-slot loader (`var keytar = require('../build/Release/keytar.node')` in keytar 7.9.0) with a multi-platform-aware loader keyed on `process.platform`-`process.arch`. The patch is staging-only — `node_modules/keytar/` in the project tree is byte-identical pre-pack and post-pack, pinned by the new `scripts/verify-pack-isolation.js` (run via `npm run verify:pack-isolation`). Pre-patch substring assertion on the upstream loader fails loud if a future keytar bump changes the loader shape.

- **Bridge emits one operator-visible `Config source:` line on startup to stderr** (PR [#36](https://github.com/Wicked-Evolutions/abilities-mcp/pull/36), closes [#32](https://github.com/Wicked-Evolutions/abilities-mcp/issues/32)). Captured in Claude Desktop's per-server MCP log so the operator can tell at a glance which `loadConfig` source won. Names the source (`env-var` / `[explicit-config]` / `[script-adjacent]` / `[home-dir]` / `legacy-cli`), the file path (tildified) or hostname, the site count, and the per-site auth method. Sample output:
  ```
  Config source: ABILITIES_MCP_URL env var (single-site basic auth: example.com as wp_user)
  Config source: [home-dir] ~/.abilities-mcp/wp-sites.json (3 sites: helena oauth, wicked oauth, tnn apppassword)
  ```
  No secrets — only IDs, methods, hostnames, paths, counts. Always-on, not gated by `--debug`.

- **`.mcpb` install seeds `~/.abilities-mcp/wp-sites.json` on first launch** (PR [#37](https://github.com/Wicked-Evolutions/abilities-mcp/pull/37), closes [#34](https://github.com/Wicked-Evolutions/abilities-mcp/issues/34)). When the env-var-mode bridge boots and the home-dir config doesn't exist, `seedFromEnvIfMissing` writes a v2 apppassword entry derived from the `ABILITIES_MCP_*` env vars before serving the first MCP request. `list-sites`, `upgrade-auth`, and `add-site` now operate on a single source of truth that already includes the `.mcpb`-installed site. The site-id is derived from the URL hostname, matching `add-site`'s `deriveSiteId`. Guards: pre-existing `wp-sites.json` is **never overwritten**; missing env vars / malformed URL / keytar unavailable → graceful no-op (bridge falls back to env-var-only mode); file-write failure → keychain entry rolled back so operators don't accumulate orphan secrets.

### Changed

- **keytar pinned `^7.9.0` → `~7.9.0`** (patch versions only) so the staging script's pre-patch loader-shape substring assertion has a stable target. CLI install behavior is unchanged — keytar stays in `optionalDependencies` (skips gracefully on platforms without prebuilds).
- **`_configSource` discriminant renamed `'env'` → `'env-var'`** to align with the documented set (`explicit-config`, `script-adjacent`, `home-dir`, `env-var`, `legacy-cli`). Internal field, prefixed with underscore; only one test was reading the prior value (updated).

### Internal

- **Bundle size:** `~115 kB → ~413 kB` packed / `~1.2 MB` unpacked. The four platform-specific keytar prebuilds (darwin-x64 ~83 kB, darwin-arm64 ~99 kB, win32-x64 ~707 kB, linux-x64 ~76 kB) are embedded for the `.mcpb` install path. CLI install paths are unaffected — keytar stays in `optionalDependencies` and is host-only via the operator's `npm install`.
- **Test count:** `237 → 265` (+28 across the sprint: 0 new in PR #35, +15 in PR #36, +13 in PR #37). Node CI matrix unchanged: 18, 20, 22.
- New maintenance scripts: `npm run pack:mcpb` (staging build + multi-platform prebuild fetch), `npm run verify:pack-isolation` (asserts `node_modules/keytar/` byte-identity across pack runs).

## [1.5.1] - 2026-05-02

Stretch-to-stable release. Closes the OAuth 2.1 alpha audit pass and the two integration-seam regressions surfaced during Helena's Phase B operator verification, plus the async-config tech-debt sweep that shares the bridge's startup path. No new features, no surface changes — the v1.5.x line is now stable for broader operator adoption.

Companion releases: [abilities-mcp-adapter v1.4.4](https://github.com/Wicked-Evolutions/abilities-mcp-adapter/releases/tag/v1.4.4) and [abilities-for-ai v1.9.1](https://github.com/Wicked-Evolutions/abilities-for-ai/releases/tag/v1.9.1) — coordinated multi-repo release per the Stretch to Stable sprint plan.

### Fixed

- **Schema v1→v2 auto-migration is now actually wired into boot** (PR #25, closes #23). `migrateFile()` shipped in v1.5.0 but the Phase 4/5 OAuth handoff missed the call sites — the migration code existed but never ran. Now invoked at two points before any consumer touches the config: (a) in `abilities-mcp.js` startup before the MCP server reads `wp-sites.json`, and (b) in `lib/cli/index.js`'s `runCommand()` before any subcommand parses the file. Both call sites share a single `KeychainSecretStore` instance. CLI subcommands no longer error with `v<unknown> but CLI expects v2` against legacy v1 configs; the OAuth `add-site` / `upgrade-auth` flows can reach the auth code path on a fresh install. Idempotent — second-run on an already-v2 file is a no-op.
- **Post-migration v2 apppassword sites validate and connect** (PR #27, closes #26). Helena's Phase B run surfaced a regression: when PR #25's wired migration converted a multi-site v1 config to v2, every non-OAuth site moved to `auth.method: 'apppassword'` with `auth.password_ref`, and the legacy `http.password` / `http.passwordEnv` / `http.passwordCommand` fields were stripped per Appendix F.5 — keychain becomes the sole source of truth. The runtime side still spoke v1 only: `validateSiteConfig()` had no apppassword branch, so v2 sites fell through to the legacy http validator which rejected them with `requires one of http.password, http.passwordEnv, or http.passwordCommand`, and `ConnectionPool._createTransport` had no resolver for `auth.password_ref`. Two parallel branches added (validator + async `resolveSitePassword(site, secretStore)` helper that reads keychain via the SecretStore), pool dispatches on `auth.method === 'apppassword'`, and `KeychainSecretStore` is constructed lazily so SSH-only / v1-only setups still avoid loading keytar. Multi-site acceptance test (1 oauth + 2 apppassword + 1 ssh-carrier) pins the routing.

### Changed

- **Async config loading** (PR #28, closes #5). The boot chain — `resolveConfigFilePath`, `loadConfig`, `loadConfigFile`, `validateSiteConfig`, `resolvePassword` — is async. File reads use `fs.promises`; the `passwordCommand` shell-out goes through `util.promisify(exec)` rather than `execFile` so existing operator configs that rely on shell features (pipes, redirects, `$()` substitution — e.g. `op read 'op://Vault/foo' | tr -d '\n'`) keep working unchanged. `loadConfig` now returns a `Promise`; `abilities-mcp.js`'s bootstrap awaits it (the IIFE was already async per the migration wiring above). Pure-dispatch helpers (`resolveSiteKey`, `buildSiteKeyEnum`, `buildEnvConfig`, `buildLegacyConfig`) stayed synchronous — they have no I/O and converting them would touch every call site for no runtime benefit.

### Internal

- Test count: 237 (+27 since 1.5.0). Node CI matrix: 18, 20, 22.
- Validator coverage extended: 8 acceptance/reject cases for v2 apppassword (http and ssh carriers, hand-edited reject paths), 9 cases for the async surface (`loadConfig` Promise return, `resolveConfigFilePath` async, `resolvePassword` env / command / shell-feature regression).

## [1.5.0] - 2026-04-28

OAuth 2.1 release. The bridge is now a full OAuth client: it discovers the authorization server via RFC 9728, performs Dynamic Client Registration (RFC 7591), drives the authorization-code grant with PKCE S256 (RFC 7636) through a loopback browser flow (RFC 8252), persists tokens in the OS keychain, refreshes them automatically, and sends Bearer tokens through the runtime MCP transport.

Companion release: [abilities-mcp-adapter v1.4.3](https://github.com/Wicked-Evolutions/abilities-mcp-adapter/releases/tag/v1.4.3) — the OAuth resource server + authorization server.

### Added — OAuth 2.1 client core (#15)

- **`lib/auth/` module** — full OAuth 2.1 client: `oauth-client.js` (state machine), `discovery-client.js` (RFC 9728 + RFC 8414, refuses HTTP, refuses redirects on `.well-known/*`, throws `CapabilityPinningError` on pinned 404), `dcr-client.js` (RFC 7591), `pkce.js` (32-byte verifier, S256, 16-byte hex state, `crypto.timingSafeEqual` with length-mismatch CPU-burn defense), `loopback-server.js` (RFC 8252 loopback callback), `browser-launcher.js` (cross-platform `open`), `token-manager.js` (refresh window, retry semantics, expired/revoked state machine).
- **`SecretStore` interface** — three implementations: `keychain-secret-store.js` (libsecret on Linux, Keychain on macOS, Credential Manager on Windows), `memory-secret-store.js` (testing), `secret-store.js` (interface). All token persistence flows through this interface.
- **`BridgeIdentityProvider` interface** + **`FreshEachTimeIdentityProvider`** (v1.0 implementation per Appendix H.3.2 binding amendment): `getClientId()` always returns null → fresh DCR on every flow. `persistClientId()` is a documented no-op pending v1.1's persistent-identity upgrade contract.
- **`schema-v2.js`** — keychain references replace inline secrets in `wp-sites.json`. `schema_version: 2` with `auth.method`, `access_token_ref`, `refresh_token_ref`, `oauth_capability_pinned`, `apppassword_fallback`. `config-migration.js` upgrades v1 configs in place.
- **`OAuthHttpTransport`** (#18) — runtime transport that uses `TokenManager.getAccessToken()` before each request, builds `Authorization: Bearer ...`, handles 401 → `forceRefresh` → retry-once, surfaces terminal auth failure via `onAuthStatusChange('expired')`. `ConnectionPool._create()` dispatches to this when `siteConfig.auth.method === 'oauth'`.

### Added — OAuth CLI subcommands (#16)

- **`abilities-mcp <subcommand>`** dispatches to eight new subcommands wrapping `lib/auth/`: the six in the sprint plan — `add-site`, `reauth`, `revoke`, `list-sites`, `test`, `upgrade-auth` — plus two design-doc extensions: `force-downgrade` (J.1, escape hatch for the H.2.3 capability-pin failure) and `self-check` (J.2, the H.2.6 Authorization-header probe). Each subcommand subscribes to the OAuth state machine and prints operator-facing progress lines. Error messages name the exact next action. Bare `node abilities-mcp.js` (no subcommand) still starts the MCP STDIO server unchanged.
- Exit-code table (`0`/`1`/`2`/`3`/`4`/`5`) mapping success / generic / usage / config / auth / capability-pinning failures, documented in `abilities-mcp --help`.
- `--debug` flag includes the `cause` stack on errors for troubleshooting.
- `force-downgrade` audit lives on the site config (`force_downgrade.{at, expires_at, reason}`) and is surfaced in `list-sites` for 30 days.

### Security

- **H-7: removed dead refresh-intent keychain code** (#21). `TokenManager.refresh()` previously wrote a `${siteId}/refresh-intent` keychain entry before sending the refresh request and deleted it on every exit path. The marker had no reader — the original H.2.1 mid-flight crash-recovery semantics were never implemented. With the adapter's C-2 fix shipping encrypt-at-rest grace-window retry on the server (adapter PR #61), the bridge no longer needs an in-flight intent marker. Pure deletion of dead code that paid a keychain write per refresh.
- **H-8: client_id port guard in `_runRegister`** (#22). `OAuthClient._runRegister` previously returned a persisted `client_id` from `identityProvider.getClientId()` without verifying that the registered loopback redirect_uri's port matched the live loopback port. v1.0 was safe by accident because `FreshEachTimeIdentityProvider.getClientId()` always returns null. v1.1's persistent-identity upgrade (per Appendix H.3.2) would have surfaced the bug: a stale persisted client_id whose registered port no longer matched would fail server-side `redirect_uri_valid()`. Defensive fix: `_runRegister` now always calls `identityProvider.clearClientId()` before DCR. v1.1+ designs that want to short-circuit DCR on persisted client_id must do so at the `OAuthClient.run()` level after verifying the loopback port matches the registration. See follow-up [abilities-mcp-adapter#73](https://github.com/Wicked-Evolutions/abilities-mcp-adapter/issues/73) for the spec amendment.

### Internal

- Test count: 210 (+34 since 1.4.0). Node CI matrix: 18, 20, 22.
- `infra: retarget project automation` (#14) for the OAuth sprint workflow.

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
