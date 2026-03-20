# Gotcha: MCP Adapter `empty()` Bug

**Severity:** High — all ability execution blocked
**Fixed in:** abilities-mcp-adapter v1.1.0 (2026-03-10)
**Affects:** The Adapter plugin (server-side PHP), not the bridge

## The Problem

`ExecuteAbilityAbility.php` used `empty($input['parameters'])` to check for missing parameters. PHP's `empty()` treats `[]` (empty array from JSON decode of `{}`) as truthy for emptiness, converting it to `null`.

WordPress core's `validate_input()` rejects `null` against `"type": "object"` schemas.

## The Failure Chain

1. MCP client sends `{}` as parameters (valid empty object)
2. JSON decode produces `[]` (empty PHP array)
3. `empty([])` returns `true` → parameters set to `null`
4. WordPress validates `null` against `"type": "object"` → rejects
5. Ability call fails with schema validation error

## The Fix

```php
// WRONG
$parameters = empty($input['parameters']) ? null : $input['parameters'];

// CORRECT
$parameters = $input['parameters'] ?? array();
```

## The Broader Rule

**Never use `empty()` for parameter presence checking** in PHP code that handles JSON-decoded data. Use `??` (null coalescing) or `isset()`.

## Second Bug: `ability_missing_input_schema`

Same file had a related bug: `ExecuteAbilityAbility` always passed `$parameters` to `$ability->execute()`. WordPress core's `validate_input()` rejects non-null input for abilities with no `input_schema`.

Fix:
```php
$execute_input = empty($ability->get_input_schema()) ? null : $parameters;
```

## Why This Is Documented Here

This is an Adapter bug, not a bridge bug, but it manifests as bridge-side failures ("all abilities return errors"). If you're debugging ability execution failures at the bridge level, check the Adapter version first.
