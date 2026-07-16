# Changelog

## 0.1.1

First recommended production release. The published `0.1.0` tag and image remain immutable but are superseded.

- Enforces stable, lifetime-scoped WhatsApp webhook HMAC authentication and safe malformed-signature handling.
- Shares one registered Mattermost adapter across discovery, sending, identity, and intake.
- Masks credential-shaped setup values centrally and writes configuration/authentication artifacts atomically with restrictive permissions.
- Supports clean container setup through `/config/.env` and immutable Compose image overrides through `FELIX_IMAGE`.
- Pins the Node and Go build images to current Debian Trixie digests, hash-locks the Python 3.13 runtime, and applies a reviewed OpenVEX risk gate.
- Uploads AMD64 and ARM64 Trivy SARIF under distinct code-scanning categories.
- Publishes only through immutable candidate, verified manual release, and separate `latest` promotion workflows.

## 0.1.0

Superseded by `0.1.1`. The source tag and Docker image remain available unchanged for rollback and audit purposes.

- Docker Compose deployment for `linux/amd64` and `linux/arm64`.
- Mattermost, Discord, Slack, WhatsApp, and Telegram source adapters.
- Codex, OpenCode, and Claude Code harnesses.
- Owner console with approvals, contacts, skills, sessions, audit history, and usage reporting.
- Persistent filesystem-based Workspace data with migration support.
- Bundled skills for database access, browser work, documents, memory, development, task management, and reporting.
- Patched dependency tree with clean root and web npm audits.
- Runtime bot identities are discovered from authenticated platform APIs or paired WhatsApp state; setup no longer asks for bot IDs or usernames.
- Telegram requires successful `getMe` discovery at startup; legacy Telegram identity values remain parseable but are not runtime fallbacks.
- Initial release publication workflow; replaced by the candidate-first `0.1.1` process.
