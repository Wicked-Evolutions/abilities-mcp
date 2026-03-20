# Contributing to Abilities MCP

We welcome contributions — bug reports, feature ideas, code, documentation, and questions.

## How We Work

This project is built by a human founder and a team of AI agents. The founder does not read or write code. The AI team (Claude, operating across multiple specialized roles) handles architecture, development, code review, testing, and documentation. The founder directs strategy, makes product decisions, and approves what ships.

Every contribution — issue, PR, or discussion — is reviewed by the AI team and discussed with the founder before merging. This means:

- **Response times vary.** We review in batches, not in real-time.
- **PRs require approval.** The `main` branch is protected. All external contributions come through pull requests.
- **We may ask clarifying questions.** Context helps us make better decisions.
- **We may adapt your contribution.** If the direction is right but the implementation needs adjustment for our architecture, we'll work with you on it.

## Reporting Bugs

Open an issue with:
1. What you expected to happen
2. What actually happened
3. Steps to reproduce
4. Your environment (Node.js version, OS, WordPress version, MCP client)

If the bug involves a specific MCP tool call, include the tool name and parameters.

## Suggesting Features

Open an issue describing:
1. What you want to do (the use case, not just the feature)
2. Why existing abilities or tools don't cover it
3. Any ideas on implementation (optional)

We track all feature requests as GitHub issues and prioritize based on how many users need them and how they fit the product direction.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Write clear commit messages describing what and why
4. Open a PR against `main`
5. Describe what your PR does and which issue it addresses (if any)

### What makes a good PR

- **Focused.** One concern per PR. A bug fix is not also a refactoring.
- **Tested.** Describe how you verified it works. If you added tests, even better.
- **Documented.** If your change affects user-facing behavior, update the relevant docs.

### What we look for in review

- Does it fit the architecture?
- Does it handle errors gracefully?
- Does it follow the existing code patterns?
- Could it break existing users?

## Code Style

- **JavaScript** (this repo): No dependencies. Node.js built-in modules only. No transpilation.
- Consistent with existing code. When in doubt, follow the patterns you see.

## Security

If you discover a security vulnerability, **do not open a public issue.** Email the details to the contact in SECURITY.md. We take security seriously and will respond promptly.

## License

By contributing, you agree that your contributions will be licensed under the GPL-2.0-or-later license.
