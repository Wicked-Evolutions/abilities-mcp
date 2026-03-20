# Gotcha: Multisite Blog ID Switching

**Severity:** High — abilities missing or wrong data returned
**Fixed in:** abilities-mcp v1.1.0 (PR #6)

## The Problem

In a WordPress multisite, the bridge initially tried to use a single endpoint URL with a `blog_id` parameter. This doesn't work — WordPress needs to boot natively into the correct blog context.

## Why `switch_to_blog()` Fails

`switch_to_blog()` only switches the database prefix. It doesn't reload plugins, themes, or REST routes. Abilities registered by plugins on a subsite may not be available after a `switch_to_blog()` call.

## The Fix

Each subsite gets its own endpoint URL. The bridge's `resolveSiteKey()` in `config.js` maps dot-notation site keys to their endpoint URLs:

```json
{
  "network": {
    "transport": "http",
    "http": {
      "endpoint": "https://example.com/wp-json/mcp/mcp-adapter-default-server"
    },
    "multisite": {
      "main": "https://example.com/",
      "blog": "https://blog.example.com/"
    }
  }
}
```

Use `site: "network.blog"` → WordPress boots natively into the blog's context via the domain.

## Connection Pool

The bridge reuses existing transport connections per endpoint. Creating a competing connection to the same endpoint causes session conflicts. The connection pool was fixed in PR #2 to reuse transports for same-endpoint subsites.

## Detection

If a multisite subsite returns wrong data or missing abilities:
1. Check that the subsite has its own URL in the `multisite` config
2. Verify the endpoint URL resolves to the correct blog (check `wp-json/` response for `home` URL)
