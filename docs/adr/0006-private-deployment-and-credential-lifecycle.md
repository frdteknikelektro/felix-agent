# ADR 0006: Private deployment and credential lifecycle

## Status

Accepted for Felix 0.1.1.

## Decision

The runtime is private by default: Compose binds the owner console to
loopback, and remote console or public webhook access requires a
customer-managed HTTPS reverse proxy. Secrets remain outside the image and are
mounted through the Compose secret `.env` file. Filesystem Workspace data is
the persistence boundary; no internal database engine is introduced.

Google authorized accounts and the `gog` file keyring persist under `GOG_HOME`
on the Workspace volume. OAuth credential templates are generated in `/tmp`,
imported with environment expansion, and deleted. Backups must include the
Workspace, `.env`, `DB_ENCRYPTION_KEY`, and `GOG_KEYRING_PASSWORD`.

Existing owner secrets remain valid with a prominent warning. Setup requires at
least 24 characters for new or replaced values and retains cryptographically
generated defaults. Setup writes `/config/.env` atomically with owner-only
permissions; authentication files use the same atomic-write rule.

## Consequences

Customers own network termination, certificates, firewall policy, and remote
access controls. Recovery is a filesystem restore plus the matching secret
environment, and production image references use `0.1.1` or an immutable digest.
