# Changelog

All notable changes to Abilities MCP are documented here.

## [Unreleased]

### Fixed

- **OAuth subsite routing actually targets the subsite host (Issue [#48](https://github.com/Wicked-Evolutions/abilities-mcp/issues/48), Public Alpha Hardening Phase A.1).** v1.5.4 wrote the `multisite` block on add-site but the OAuth dispatch path ignored the resolved subsite endpoint — every `<network-id>.<subsite-slug>` ability call was POSTed to the network root, so WordPress booted blog 1 regardless of which subsite was named. Three connected fixes:
  - `lib/config.js:resolveSiteKey` now derives `resolvedEndpoint` for OAuth subsites (was HTTP/App-Password only). OAuth sites carry their endpoint on `mcp_resource`, not `http.endpoint`, so the substitution branch never fired for the OAuth case.
  - `lib/connection-pool.js:_createTransport` passes `{ resolvedEndpoint, subsiteUrl: finalSubsiteUrl }` through to the OAuth branch, mirroring the HTTP branch's pattern. `_createOAuthHttpTransport` uses `resolvedEndpoint || siteConfig.mcp_resource` and forwards `subsiteUrl` to the transport.
  - `lib/connection-pool.js:_findExistingHttpTransport` dedupes OAuth subsites by `resolvedEndpoint || mcp_resource` (was always `mcp_resource`). Without this, the cached network-root transport was returned for every subsite key, making the endpoint fix functionally inert behind the cache lookup.
  - `lib/transports/oauth-http-transport.js` accepts `subsiteUrl` and forwards it on every POST as `X-Abilities-MCP-Subsite-URL`. Subdomain-style multisite (the alpha-locked scope) routes by host in the endpoint URL and does not need the header; it's forward-looking infrastructure for path-style multisite (Phase B) so the adapter can `switch_to_blog()` per request without re-parsing the request URL.
- **Multisite probe pages through `multisite/list-sites` (Issue [#49](https://github.com/Wicked-Evolutions/abilities-mcp/issues/49), Public Alpha Hardening Phase A.2).** v1.5.4's `add-site` probe issued a single `multisite/list-sites` call with `per_page=100`, so networks with more than 100 sites silently got a truncated `multisite` block while `add-site` reported success. `lib/cli/multisite-probe.js` now loops `page=1..N` accumulating items across pages, terminating on the first of: empty page, partial page (length < `PROBE_PER_PAGE`), body-level `total` / `total_pages` reached, or the 50-page cap (`PROBE_PAGE_CAP × PROBE_PER_PAGE = 5,000` sites). When the cap is reached with a still-full final page, the probe throws a typed `Error` with `code === 'probe_cap_exceeded'` and `data: { count, cap }` so an operator hitting it gets a clean diagnostic rather than a silently-truncated block. The cap is a hard constant — no env shim — because >5,000-site networks are an exceptional case that should engage maintainers. Body-level `total` / `total_pages` (when the adapter exposes them) take precedence over the partial-page fallback to avoid one redundant page request when the last page is exactly full.

## [1.5.4] - 2026-05-04

This release lands the bridge-side foundations for the multisite UX promised in [#43](https://github.com/Wicked-Evolutions/abilities-mcp/issues/43). `add-site` now requests multisite OAuth scopes during DCR (so super-admin operators consent through the standard consent flow), runs a one-shot `multisite/list-sites` probe after OAuth completes, and on success writes a slug→subsite-URL `multisite` block to `wp-sites.json` so the bridge's existing dot-notation routing serves multi-site OAuth in any AI client without operator JSON editing. End-to-end dot-notation routing validated on darwin-arm64 against a 4-subsite multisite by manually populating the block from the verified `multisite/list-sites` response.

Bridge-only release — no companion adapter or ai release this release.

### Added

- **`add-site` auto-populate: probes `multisite/list-sites` after OAuth on the freshly-authenticated bridge connection** (PR [#44](https://github.com/Wicked-Evolutions/abilities-mcp/pull/44), closes [#43](https://github.com/Wicked-Evolutions/abilities-mcp/issues/43)). Builds the slug→subsite-URL block from the response and attaches it to the new site entry before persisting `wp-sites.json`. Schema verified against the existing dot-notation routing implementation (`lib/config.js:resolveSiteKey` + `lib/connection-pool.js:_findExistingHttpTransport`) — slug→URL string map, no schema migration. Single-site / non-multisite / permission-denied / network-error all degrade gracefully, with stderr advisory naming the failure where appropriate (silent for the expected single-site case). New `lib/cli/multisite-probe.js` houses a one-shot bearer JSON-RPC client (minimal MCP handshake + `tools/call`, distinct from the runtime `OAuthHttpTransport` so the probe runs once with the freshly-minted in-memory access token without the queue/batch machinery) plus pure schema-mapping helpers (`buildMultisiteBlock`, `deriveSubsiteSlug`) covering subdomain mode, path-based mode, slug-collision disambiguation by `blog_id`, and `www.` parent stripping.
- **`add-site` DCR scope request now includes `abilities:multisite:read` and `abilities:multisite:write`** (PR [#46](https://github.com/Wicked-Evolutions/abilities-mcp/pull/46), closes [#45](https://github.com/Wicked-Evolutions/abilities-mcp/issues/45)). The adapter's `ScopeRegistry` classifies multisite scopes as `SENSITIVE_SCOPES` and intentionally excludes them from the `abilities:read` / `abilities:write` umbrella expansion, so explicit DCR requests are the only way the consent screen surfaces them for super-admin operators on a Multisite Network root. Single source of truth in `DEFAULT_SCOPE` (`lib/auth/oauth-client.js`), picked up by `add-site` / `reauth` / `upgrade-auth` automatically. Single-site WP installs unaffected — the adapter declines to grant scopes the OAuth user lacks WP capability for, so single-site operator UX is preserved.

### Changed

- **Permission-denied advisory wording in `add-site` rewritten to surface BOTH possible failure causes** so operators don't chase the wrong layer: (1) the OAuth user lacks the `manage_network_options` WP capability, or (2) the OAuth token lacks the `abilities:multisite:read` scope (granted on the consent screen). Both gates can produce the same observable rejection from `multisite/list-sites`; the advisory now names both explicitly with re-run guidance.

### Internal

- **Test count:** `275 → 293` (+18 across PR #44 +14 and PR #46 +4). Node CI matrix unchanged: 18, 20, 22.
- **Bundle size unchanged** (~413 kB packed / ~1.2 MB unpacked — no binary or dependency changes this release).
- **Run-contract extension:** `lib/cli/index.js` now forwards `errLines` from successful subcommand returns so non-fatal stderr advisories can surface without changing exit semantics. Backwards-compatible — subcommands that don't set `errLines` get the previous empty-array behavior. Internal CLI surface only; the bin entrypoint already writes `errLines` to stderr (`abilities-mcp.js:62`).

### Known issue (linked to adapter follow-up)

- **The auto-populate's happy path does not currently fire end-to-end** due to an adapter-side bearer-auth quirk that rejects `multisite/list-sites` from the bridge's fresh-token one-shot probe — even when the OAuth user is a super admin and the token carries the required scopes. The same operation against the same tokens succeeds when invoked from an established MCP runtime session in any AI client. Tracked at [abilities-mcp-adapter#87](https://github.com/Wicked-Evolutions/abilities-mcp-adapter/issues/87) — adapter-side fix; bridge code is correct in isolation. Operators following the documented v1.5.4 flow today will hit the bridge's documented graceful-degrade path: site entry written without the `multisite` block, advisory printed, manual block edit OR an immediate `multisite/list-sites` call from any already-connected MCP client (which writes nothing — operator copies the response into `wp-sites.json`) lets dot-notation routing work end-to-end. End-to-end dot-notation routing validated on darwin-arm64 against `wickedevolutions.com` multisite (4 subsites: `main`, `community`, `knowledge`, `test1`) by manually populating the block — 106 published posts returned correctly from `wickedevolutions.community` through the bridge's existing routing.

## [1.5.3] - 2026-05-04

**macOS hotfix: OAuth in Claude Desktop's `.mcpb` runtime now works.** Hotfix to v1.5.2's `.mcpb` operator UX on macOS. v1.5.2 shipped with keytar prebuilds bundled, but Claude Desktop's hardened-runtime host process on macOS rejects native modules with mismatched code-signing Team IDs — a system-level macOS protection that applies to every hardened app, not a Claude Desktop quirk. This blocked OAuth inside Claude Desktop's `.mcpb` runtime even though the bundle itself is structurally correct (loads cleanly via system Node from the extracted `.mcpb`). The hotfix adds a darwin-only shell-out to the macOS `security` CLI when keytar fails to load. Validated end-to-end on darwin-arm64 by an operator running the documented progression (install `.mcpb` → `upgrade-auth` → `add-site` → multi-site OAuth in the same Claude Desktop entry, read and write confirmed live on two production WordPress sites via OAuth bearer) before release.

Bridge-only release — no companion adapter or ai release this hotfix.

### Fixed

- **`KeychainSecretStore` falls back to the macOS `security` CLI when keytar fails to load on darwin** (PR [#40](https://github.com/Wicked-Evolutions/abilities-mcp/pull/40), closes [#39](https://github.com/Wicked-Evolutions/abilities-mcp/issues/39)). When `require('keytar')` throws on darwin (the hardened-runtime Team ID mismatch), `_load()` sets `_fallbackMode = 'security-cli'` instead of throwing. `get` / `set` / `delete` then dispatch to `security find-generic-password -w` / `add-generic-password -U` / `delete-generic-password` via `child_process.execFile` (no shell — argv passes verbatim, no shell-injection surface). `findAll` returns `[]` in fallback mode (security CLI has no clean enumerate-by-service; the bridge runtime path doesn't depend on it — only the CLI subcommand `list-sites` does, which runs in system Node where keytar loads normally). Stderr matching `/could not be found/i` maps to keytar's null (get) / false (delete) return semantics; other stderr propagates as `SecretStoreError` code `security_cli_failed`. `isAvailable()` returns true in both keytar and fallback modes. **Linux/Windows behavior unchanged** — keytar load failures on those platforms still throw `keytar_unavailable` (no fallback engaged; the security CLI is darwin-only). Test seams (`requireKeytar`, `platform`, `exec` injection on the constructor) added for fallback-path unit testing without breaking the test runtime's real `require('keytar')`. New `test/auth/keychain-secret-store-darwin-fallback.test.js` covers keytar-success preservation, fallback engagement on darwin, "could not be found" mapping, error propagation, `isAvailable` in both modes, linux/win32 throw-not-fallback, and `findAll` in fallback mode. The first time the `.mcpb`-installed bridge accesses a keychain entry on darwin, macOS will prompt for keychain access — operator clicks "Always Allow" once per entry and the prompt persists thereafter. This is a macOS keychain ACL property; the same prompt would have appeared with keytar-native if it had loaded.

### Internal

- **Test count:** `265 → 275` (+10 in `keychain-secret-store-darwin-fallback.test.js`).
- **Bundle size unchanged** (~420 kB packed, ~1.3 MB unpacked — the four platform-specific keytar binaries dominate; the secret-store code change is small relative to that).

### Known unverified — research outstanding for a follow-up release

- **Linux:** whether keytar's libsecret native binding loads cleanly inside Linux Claude Desktop's `.mcpb` runtime is unverified. Likely works (Linux's runtime model differs from macOS — no Team ID matching), but no Linux Claude Desktop access during this hotfix to test empirically. Operators on Linux Claude Desktop should test and report.
- **Windows:** whether keytar's win32 native binding loads cleanly inside Windows Claude Desktop's hardened process is unverified. If it doesn't, a separate Windows-specific fix shape is needed (PowerShell credential cmdlets, or formally limiting Windows operators to the CLI install path). Tracked for a follow-up release.

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
