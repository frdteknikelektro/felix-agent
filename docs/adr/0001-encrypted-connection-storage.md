# Encrypted connection storage

Database connection credentials are stored in per-connection JSON files under `workspace/databases/connections/`, encrypted with AES-256-GCM using a dedicated random key (`DB_ENCRYPTION_KEY`) auto-generated during setup.

The connection file contains engine-specific configuration (host, port, user, database, SSH tunnel, SSL settings) plus an encrypted password field. The encryption key is a 32-byte random value generated once during `npm run setup` and stored in `.env`. Credentials are decrypted only at connect time and never logged or exposed.

## Considered Options

- **Env var references** — connection files reference `PROD_PG_PASSWORD` via env var. Rejected because every new connection requires manual `.env` editing and a container restart. Poor UX compared to desktop database managers.
- **Docker secret references** — connection files reference `/run/secrets/pg-pass`. Same restart problem, plus requires Docker-specific setup.
- **Encrypted SQLite** — single encrypted database for all connections. Referred because corruption loses all connections, and inspecting/debugging requires tooling. Per-file model matches Felix's existing patterns (sessions, contacts, tasks).
- **Per-file JSON with env/secret references** — credentials stored as references, not encrypted. Rejected because it offloads credential management to the operator.
- **Key from OWNER_UI_SECRET** — derive encryption key from the owner's UI secret. Rejected because it couples two unrelated security domains.

## Consequences

- Owner manages connections through conversation or owner console UI — no `.env` editing.
- Losing `DB_ENCRYPTION_KEY` loses all stored passwords (same risk as losing a master encryption key).
- Connection files are inspectable (except password field), diffable, and backable.
- One corrupted file affects one connection, not all.
