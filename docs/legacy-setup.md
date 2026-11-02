# Legacy standalone setup

This note is for an existing installation of Abilities for AI and Abilities MCP Adapter, with Abilities for Fluent Plugins where that was also installed. It is not the recommended path for a new Mycelium setup. These repositories are private; this note does not imply that downloads are publicly available.

Do not install the standalone products alongside Mycelium for WordPress. Mycelium is designed to pause its own registrations while a standalone sibling is active, so a site can be migrated safely. Follow [Mycelium's migration guide](https://github.com/Wicked-Evolutions/Mycelium-for-WordPress/blob/main/MIGRATION.md) for the required backup, activation, verification, uninstall, and rollback order.

The technical bridge configuration in this repository remains applicable to a compatible legacy endpoint, including OAuth, Application Password, `wp-sites.json`, and the command-line reference. Treat the legacy products as an existing-installation compatibility path, not as a new-user onboarding path.
