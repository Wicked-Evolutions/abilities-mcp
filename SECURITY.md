# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Abilities MCP, **do not open a public issue.**

Instead, please use [GitHub's private vulnerability reporting](https://github.com/Wicked-Evolutions/abilities-mcp/security/advisories/new) to report it directly.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

We review private vulnerability reports as bandwidth allows. We do not commit to specific response or fix timelines — this is a small team, and timing depends on severity, complexity, and what else is in flight. We will respond when we have something useful to say. Critical issues are prioritized.

## Scope

This policy covers:
- The Abilities MCP bridge (this repository)
- Configuration handling (password resolution, credential storage)
- Transport security (SSH, HTTP, session management)
- Schema sanitization

For vulnerabilities in the WordPress plugins, use the relevant repository's private reporting:
- [abilities-mcp-adapter](https://github.com/Wicked-Evolutions/abilities-mcp-adapter/security/advisories/new) — WordPress-side MCP protocol layer
- [abilities-for-ai](https://github.com/Wicked-Evolutions/abilities-for-ai/security/advisories/new) — ability provider

## Supported Versions

We support the latest released version. Older versions do not receive security patches — please update.
