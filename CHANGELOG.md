# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-10-12

### Changed

- README: installation now points to the npm package. This is the first release published from CI with npm provenance.

## [0.1.0] - 2026-10-10

### Added

- Initial release.
- Discord OAuth2 login provider for EmDash restricted to members of a configured guild, using PKCE (S256).
- Options: `guildId`, `defaultRole` (default `10`), `scopes`, `adminIds`, `bootstrapFirstAdmin`, `siteTitle`, `loginLabel`, `messages`. Options are validated when `discord()` is called.
- Admin role assignment via `adminIds` / `DISCORD_ADMIN_IDS`. An opt-in first-admin bootstrap (`bootstrapFirstAdmin` / `DISCORD_BOOTSTRAP_FIRST_ADMIN=1`) that applies only before EmDash's initial setup is complete.
- English default messages, overridable per error code with `messages`.
- 10-second timeout and `rate_limited` handling for Discord API calls, with server-side logging of failure codes.
- Mock Discord server exported as `emdash-auth-discord/testing/mock-discord` for integration tests (binds to 127.0.0.1, refuses to start in production).

[0.1.0]: https://github.com/leCielEtoile/emdash-auth-discord/releases/tag/v0.1.0
