# Gotcha: Non-Default Site Handshake IDs

**Severity:** Critical — silent total connection failure
**Fixed in:** abilities-mcp v1.0.0

## The Problem

When the bridge creates a synthetic handshake for non-default sites, the request ID must be **numeric** and fit within a 32-bit integer. Two bugs were discovered:

1. **String IDs** — `"init-wicked"` → TypeError in PHP `strict_types=1`
2. **Date.now()** — 13-digit millisecond timestamps exceed 32-bit int max → same TypeError

## The Failure Chain

1. Bridge sends `initialize` with invalid request ID
2. PHP `declare(strict_types=1)` in the Adapter's `InitializeHandler` rejects the type
3. TypeError → generic "Handler error occurred" (500 response)
4. No session ID returned → all subsequent calls fail with "Missing Mcp-Session-Id header"
5. **The entire site connection is dead.** No clear error points to the cause.

## The Fix

The bridge uses an incrementing counter starting at 1000 (`connection-pool.js`):

```javascript
// Avoids integer overflow from Date.now() (13-digit ms timestamps exceed
// 32-bit int max, causing TypeError in PHP strict_types=1 environments).
// Starting at 1000 to avoid collision with real request IDs (typically 1+).
let _synthIdCounter = 1000;
```

## Why This Is Critical

The error message ("Handler error occurred") gives zero indication that the problem is a type mismatch on the request ID. You can spend hours debugging session management, header passing, and transport logic before finding this.

## Detection

If a non-default site connection fails immediately with session errors, check:
1. Is the handshake request ID numeric and ≤ 2,147,483,647?
2. Does the Adapter's PHP use `strict_types=1`?
