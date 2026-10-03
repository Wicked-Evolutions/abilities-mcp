# OAuth renewal and credential-state design

Status: pre-implementation design for independent security/correctness review.
Scope: Abilities MCP #120, coordinated with Mycelium for WordPress #106/#107.
This document makes no live keychain, configuration, or server changes.

## What is broken

The bridge already renews access tokens before expiry and after one resource
`401`; a daily human login is not intended. The runtime currently persists an
accepted refresh only when `auth.sliding_renewal === true`. That historic local
flag is neither a refresh switch nor a server authorization policy. As a
result, an ordinary accepted refresh can replace secrets while leaving stale
expiry metadata on disk. Separate processes have no refresh/reauthorization
coordination, and a running process retains its old client ID after an
external reauthorization.

## Shared expiry contract

The bridge will consume these Mycelium token-response fields when present:

| Field | Meaning | Bridge treatment |
| --- | --- | --- |
| `expires_in` | Seconds until the access token expires. | Store as access expiry. |
| `refresh_token_timeout` | Seconds this issued refresh token may remain unexchanged. | Store as refresh-window expiry. |
| `authorization_expires_in` | Seconds until the stable authorization deadline, only where finite. | Store as human-reauthorization deadline. |

Discovery may advertise `refresh_token_expiration_types_supported` with
`authorization` and `token_timeout`. The names derive from the current IETF
Internet-Draft, not a final RFC. The server is the authority: expiry metadata
on an accepted pair, including a replayed response, is stored exactly as the
server supplies it. Each expiry is calculated from the timestamp captured
immediately before the HTTP request, not when a delayed response arrives, so
local display is conservative. The bridge never extends it locally.

Older servers without these fields remain operational. Their displayed
refresh/deadline state is `unknown/not provided by server`, never unlimited or
an asserted 90-day policy. When an older server does send the legacy
`refresh_expires_in` field, the bridge normalizes it as a compatibility alias
and labels its provenance. `refresh_token_timeout` wins if both fields occur;
a disagreement is a non-secret compatibility diagnostic, never a locally
chosen longer lifetime. The UI/CLI distinguishes access expiry, refresh-window
expiry, and a required human authorization.

`expires_in`, `refresh_token_timeout`, and `authorization_expires_in` are
accepted only as JSON number values that are positive, finite, safe integers
from **1 through 253,402,300,799 seconds**. Strings, fractions, zero,
negatives, overflow, and malformed/partial combinations are rejected. A
computed UTC timestamp outside year 0001 through 9999 is also rejected.
`expires_in` is required for a usable access token. The two optional policy
fields may be absent independently, but when present the authorization
deadline must cap computed access and refresh expiry. A malformed `2xx` is an
unknown server-commit outcome, not permission to invent a 24-hour or 90-day
value.

Absence has an exact meaning. An older server that does not advertise refresh
expiration support may omit both policy fields, which the bridge labels
unknown. The paired Mycelium renewal profile returns a finite
`refresh_token_timeout` with every successful response that contains a refresh
token, so an omission from that profile is malformed, not unlimited. Generic
IETF discovery support for `token_timeout` alone can still omit the field for
an indefinite timeout; the bridge labels that generic case unknown/not
provided and does not infer unlimited authority. `authorization_expires_in` is
omitted exactly when the authorization has no fixed deadline; it is never
represented by `0`. The common fixtures freeze these cases before code starts.

## Credential pair commit

The unit of persistence is one generation-addressed **keychain secret item**,
not independently overwritten `site/access` and `site/refresh` entries. Its
value is a strict versioned JSON credential pair containing the access and
refresh tokens plus the expiry metadata received in the same token response.
The OS keychain protects that one secret item. `wp-sites.json` contains only
an opaque generation ID, a `credential_pair_ref`, client ID, non-secret policy
metadata, and status.

On authorization or an accepted refresh:

1. Reserve an opaque generation ID and inactive pair slot in a durable,
   non-secret attempt marker before a token request.
2. After a `2xx`, validate its complete response and persist the non-secret
   response metadata under the same base generation and marker nonce.
3. Write the complete pair once to that inactive keychain account. Each
   canonical credential identity has two pair slots, for example
   `<credential-identity>/credential-pair/a` and
   `<credential-identity>/credential-pair/b`; the item itself carries its
   generation. No token is written to a journal, log, lock, environment value,
   or configuration file.
4. Under the configuration commit lock, reread/validate the current file and
   atomically switch its single pair reference, client ID where relevant,
   expiry metadata, authorization metadata, status, and generation.
5. Recheck lock ownership, then expose only that committed generation to the
   transport.

A write failure before step 3 leaves the prior committed pair intact. A crash
after the pair write but before config commit leaves the inactive slot with a
prepared generation, not a mixed pair. The durable attempt marker already
names that generation and slot. On restart, the bridge verifies the protected
pair's generation and strict shape, then safely finishes publication using the
metadata inside it; it need not reauthorize merely because the server replay
deadline has passed. If the prepared pair is absent or invalid, recovery is
limited by the marker's original replay deadline and otherwise becomes
`unknown_refresh_outcome`. It must not select an arbitrary older pair because
it may have been rotated, revoked, or expired. A missing/invalid committed
pair is a typed `credential_pair_unavailable` error.

The two-slot ring bounds keychain storage at two pair items per credential
identity. A newly committed slot is never overwritten. The previous slot may
be overwritten only under the credential lock after a new generation is
committed and all generation fences prove it retired; a current or prepared
in-flight slot is never a cleanup target. Revoke deletes the two known slots
best-effort, subject to #105's nonblocking rule. Failed revoke deletion is a
bounded two-reference cleanup task retried only on a later explicit credential
operation. This avoids daily unbounded item growth and unsafe cleanup guesses.

Existing fixed `access_token_ref`/`refresh_token_ref` configurations remain
readable. The first accepted refresh or reauthorization migrates that site to
a pair reference without bulk keychain copying. Once a pair is active, the
fixed references are removed so an older bridge cannot silently use stale
credentials. A bridge version that cannot read an active pair reference fails
closed through its existing config validation. Operator documentation supplies
the upgrade instruction; this design does not claim an old binary can emit a
specialized message it does not implement.

This is an explicit upgrade/restart boundary: before a site is moved to pair
storage, every old bridge process using that config must be stopped and
upgraded. The new bridge cannot make a safety claim about an already-running
older process that has retained its old configuration and does not participate
in locks or generation fences. The rollout test proves fail-closed config
validation for an old *newly started* bridge; it does not claim concurrent
old/new writers are safe.

## Locking and config reload

The canonical credential identity is a stable non-secret identity derived from
the normalized keychain reference pair for a legacy site and persisted with
pair storage thereafter. It is not a request alias, subsite composite key,
URL, mutable client ID, or configuration path. All aliases resolving to one
configured site share it. Credential locks live in the user-local bridge state
directory keyed by a hash of that identity, so two aliases of a configuration
cannot bypass coordination. A persistent ownership registry in that state
directory records `(canonical real configuration path, owning configured site
key)` for the identity after the operation lock is released. Any second claim
with a different tuple--including another site in the same config file--fails
closed as `shared_credential_config_unsupported`. It never assumes two config
copies sharing legacy refs can coordinate safely. An explicit human
reauthorization for the refused site mints a separate credential identity and
two new slots; it does not write, migrate, or delete the shared slots.

The registry cannot detect an already-running older bridge that does not take
locks; the upgrade/restart boundary above remains required. Two local locks
are needed because each configuration rewrite contains all sites:

* A per-credential operation lock serializes refresh and reauthorization for
  that canonical credential identity from start through outcome.
* A short global config-commit lock serializes read-modify-validate-atomic
  writes across every site, preventing two different sites from losing each
  other's whole-file changes.

The per-credential lock and the per-config commit lock are created atomically
with restricted permissions. They contain only an owner nonce, PID,
process-start identity, operation and heartbeat time. Every config writer
participates: runtime refresh/status changes, `add-site`, `reauth`,
`upgrade-auth`, `revoke`, `test`, config migration and environment seeding. A
writer rereads and validates current config under the global lock, applies only
its narrow change, then publishes it with the generation fence.

A stale lock may be reclaimed only after a bounded age and a same-host
dead-owner check. If a recorded owner might still be alive, including a paused
process with an old heartbeat or an ambiguous Windows/PID-reuse result, it is
never stolen; callers receive a typed busy state. The owner nonce and process
identity are verified before commit. If the lock cannot be safely created,
verified, or reclaimed, the bridge returns a typed coordination failure; it
never proceeds concurrently. This does not claim distributed-lock safety on a
network filesystem.

Before any server refresh, the coordinator stores a non-secret
`refresh_attempt` marker under the global lock **before the first HTTP send**:
owner nonce, base generation, reserved inactive pair reference, request-start
time, recovery deadline and attempt count. Before every later HTTP send, it
persists the incremented count and verifies that the original deadline has not
elapsed. It then releases the global lock for network work while retaining the
credential lock. This marker is the crash-safe unknown-commit record.

After a `2xx`, the bridge first validates the entire token response and, under
the global lock, persists the response's non-secret metadata against the same
base generation and nonce. Only then does it write the protected prepared pair
to the already-reserved inactive slot. The final atomic config publication
verifies base generation, nonce and prepared metadata, switches the pointer,
and clears the marker. Exact crash cuts are therefore defined: a missing pair
allows only remaining in-window recovery; a complete prepared pair matching
the marker can be safely published under the fences even after the replay
window; no path unconditionally deletes either one.

Every token read--including an ordinary request whose access token appears
still valid--obtains a coordinator-issued immutable validated snapshot. While
holding the credential coordination boundary, it reloads the external config,
checks the committed pair reference and generation, reads the protected pair,
and verifies the pair's embedded generation. An external reauthorization is
therefore adopted before every ordinary request, not only before refresh. If
another process has committed a newer generation, that current pair wins and
the old process does not send its stale refresh token. Before publication, the
coordinator rechecks that the current generation and marker nonce still equal
its base values; a delayed result then cannot overwrite a newer pair. Status
writers use the same fence and cannot overwrite credential, client-ID,
resource, or generation fields. The pool rebuilds only the affected OAuth
transport from the current client ID, refs, expiry, and resource metadata.

`reauth` holds a visible per-site authorization lock while browser consent is
in progress, but takes the short global commit lock only for final commit; it
never holds a whole-config lock while waiting for the browser. A request that
requires refresh during consent waits for a bounded period and then returns
`reauth_in_progress`; it must not combine an old client ID with new
credentials. Reauthorization merges unrelated current config fields while
atomically committing the new client ID, resource metadata, credential pair,
generation, expiry/policy data and active status.

## Lost response and replay recovery

The server's replay grace remains unchanged. Under the credential lock, a token
request uses a total recovery deadline of 25 seconds: each attempt has at most
10 seconds and there are at most two retries with bounded backoff. It retries
only a lost connection, timeout, or `5xx` with the same refresh token. It does
not retry `4xx`, weaken replay detection, or start an attempt if the remaining
budget is insufficient.

For an accepted authoritative snapshot, let `L` be the smaller of the finite
remaining access life and finite remaining refresh life. If refresh lifetime
is unknown, `L` is the remaining access life. The early-renewal lead is exactly
`min(300, max(1, floor(L / 10)), max(0, L - 1))` seconds. Thus a 10-second
lifetime has a one-second lead, a one-second lifetime has a zero lead, a
five-minute lifetime has a 30-second lead, and long lifetimes cap at 300
seconds. At the accepted snapshot, the bridge freezes and persists
`next_refresh_at = snapshot_time + L - lead`. Each later request compares its
current time with that stored due time; it does not recompute a fractional lead
against diminishing lifetimes. This refreshes before whichever credential is
shorter, including a refresh credential shorter than its access credential.

If a fixed authorization deadline enters the lead while a cached access token
is still valid, the bridge emits a clear imminent-human-authorization warning
but continues the valid ordinary request. It skips renewal only when the
persisted access expiry is already at the fixed deadline (or later because of
clock skew), because no replacement can extend usable access. A short
filter-produced access lifetime with time still remaining to the deadline can
still make renewal useful and must refresh inside the lead. The bridge does not
deny valid access early or roll the deadline forward; the server remains the
final authority at actual expiry.

Before surfacing a terminal result it reloads configuration once. A pair
committed by another process wins. On restart, a complete prepared pair
matching the marker is published under its fences. If no prepared/newer pair
exists, an unexpired marker permits only its remaining bounded recovery
attempts; the budget cannot reset per process. If the recovery deadline passes,
the marker becomes `unknown_refresh_outcome` with an actionable human
reauthorization diagnostic. The bridge must not normally retry or reuse the old
token after the replay window. Unequivocal server rejections (revocation,
invalid client, or a locally reached authoritative expiry) are recorded
separately and may clear the marker; an ambiguous `invalid_grant`, malformed
`2xx`, timeout or `5xx` retains it until recovery or budget exhaustion. The
constants are valid only against the current 30-second server grace and require
integration tests; a server-supplied replay window can replace this bridge
assumption later.

## Planned implementation surface

| Module | Responsibility |
| --- | --- |
| `lib/auth/credential-coordinator.js` (new) | Pair encoding/validation, local locks, generation commit, config reload, typed failures. |
| `lib/auth/token-manager.js` | Authoritative expiry parsing, bounded refresh recovery, coordinator use instead of two secret writes. |
| `lib/connection-pool.js` | Reload/rebuild at credential boundaries; persist every accepted refresh; remove the `sliding_renewal` persistence gate. |
| `lib/transports/oauth-http-transport.js` | Adopt only a coordinator-committed generation. |
| OAuth CLI provisioning / `reauth` | Site authorization lock and atomic final client-ID/pair commit. |
| schema, status command, README | Additive pair/provenance fields and clear operator wording. |

No database, daemon, new dependency, plaintext credential journal, or
server-side desktop-keychain control is proposed. Existing bridge #104 and
#105 retain ownership of explicit macOS keychain targeting and nonblocking
keychain operations; this scope uses only the reads/writes needed for a pair.

## Tests, maintenance, and stop conditions

Use memory secret storage for unit tests, plus a temporary file-backed **test
secret store** for spawned workers; no test touches a real user keychain. Use
temporary config files and a disposable OAuth server. Retain a reproducible,
sanitized two-process delayed-response harness. Tests must prove ordinary
refresh persistence for both old sliding-flag values,
one winning generation under concurrent refresh, crash at every marker/pair/
commit cut, retained unknown-commit marker/restart recovery within grace,
prepared-pair recovery after grace, external reauth reload with no lost
unrelated config fields, stale result generation fencing, duplicate legacy-ref
config ownership refusal, strict expiry metadata parsing and alias precedence,
early-renewal lead values for one/10/300/long-second credentials and a short
filtered access lifetime before a still-later fixed deadline, revocation/
deadline termination, old bridge fail-closed configuration handling, and
platform file/lock behavior. The publication test must demonstrate a durable
atomic point: write and sync a restrictive temporary file, replace the
destination, and sync its directory where supported; unsupported Windows
semantics must return a typed failure rather than be assumed atomic. Run `npm test`,
`npm run verify:pack-isolation`, and bundle validation after implementation;
record existing Windows #119 separately.

Stop before product code if review cannot establish reliable local lock and
atomic-replace behavior on supported platforms, if mixed-version fail-closed
compatibility cannot be demonstrated, or if Mycelium cannot provide a stable
expiry authority contract. The additive fields are reversible before release;
removing an already-shipped pair format would require a separate migration
decision.
