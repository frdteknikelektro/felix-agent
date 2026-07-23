---
name: database
description: >-
  Manage and query database connections. Use when the user mentions databases,
  tables, queries, SQL, connections, schemas, backup, migration, or wants to
  inspect, query, backup, or migrate data.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: connection.read, connection.write, read.*, write.*, admin.*
  match: database, query, sql, table, connection, schema, backup, migration
---

# Database

## Permissions

- `connection.read` — view/list connection config files (alias, engine, host, no secrets).
- `connection.write` — create, edit, or delete connection config files.
- `read` — SELECT, SHOW, DESCRIBE, EXPLAIN, schema introspection.
- `write` — INSERT, UPDATE, DELETE, DDL (CREATE/ALTER/DROP).
- `admin` — CREATE/DROP DATABASE, GRANT, REVOKE, user management, backups.

`connection.read`/`connection.write` are global, not per-alias — `database:connection.read` and `database:connection.write` (no alias suffix). They gate the connection **config file itself** (workspace/databases/connections/<alias>.json) — unrelated to `read`/`write`/`admin`, which gate query execution against the connection's target database.

`read`/`write`/`admin` are scoped by connection alias:

- `database:read.prod-pg` — read access to one connection.
- `database:read.*` — read access to all connections (full wildcard only; no partial patterns).

The server-computed `permissions_per_skill` block is authoritative: for these scoped permissions its `have=[...]` lists the contact's actual grants. Check that the alias the current operation targets is covered — an exact `read.<alias>` grant or the `read.*` wildcard. If it is not, emit `PERMISSION_REQUIRED` with the narrowest permission the operation needs (e.g. `read.prod-pg`, not `read.*`).

## Connection management

CRUD on connection config files:

1. **List/view.** Requires `database:connection.read`. Read `workspace/databases/connections/`, list aliases + engine/host/database (no secrets).
2. **Create.** Requires `database:connection.write`. Collect engine, host, port, database, credentials, optional `ssh`/`timeout_ms`. Encrypt the password with `DB_ENCRYPTION_KEY` before writing. Never echo the plaintext secret back.
3. **Edit.** Requires `database:connection.write`. Re-encrypt if the password changes; leave other fields untouched unless specified.
4. **Delete.** Requires `database:connection.write`. Confirm the alias with the user before removing the file — irreversible.

## Execution

1. **Resolve the target connection.**
   Read `workspace/databases/connections/` and match by alias, engine, host, or database name. If multiple matches, list candidates (filtered to aliases the contact holds a `database:<tier>.<alias>` permission for, any tier) and ask the user to clarify. If no matches, list available aliases under the same filter — enumerating the full connection catalog is a `connection.read` operation, not part of query resolution.
   Completion: exactly one connection file resolved, or user corrected the target.

2. **Check permission.**
   Determine the operation type (read, write, admin). If the operation is connection-config CRUD rather than a query, follow **Connection management** above instead. Check the server-computed `permissions_per_skill` block's `have=[...]` for `<tier>.<alias>` (exact) or `<tier>.*` (wildcard) covering the resolved connection. If neither is present, emit `PERMISSION_REQUIRED` for `<tier>.<alias>` and stop.
   Completion: permission verified or `PERMISSION_REQUIRED` emitted.

3. **Establish connection.**
   Read the connection file. Decrypt password using `DB_ENCRYPTION_KEY` via the query wrapper script. If the connection has an `ssh` block, open the tunnel first via the `ssh` skill, then point the connection at the tunnel's **local bind** (e.g. `127.0.0.1:<local_port>`) — do not dial the remote `host` directly. Connect to engine. Test connectivity.
   Completion: connection alive, ready to execute.

4. **Execute the operation.**
   Run the operation through the Node.js driver wrapper (`skills/database/query.mjs`). Use the `query` command for reads and `execute` for writes/DDL — `query` is enforced read-only by the wrapper (it rejects INSERT/UPDATE/DELETE/DDL and non-read Redis commands with `write_requires_execute`), so a `read`-tier operation cannot mutate data even if misclassified. Only call `execute` after a `database:write.<alias>` / `database:admin.<alias>` permission check. For schema introspection, use the `schema` command. For backups, use engine-specific dump commands. For migrations, run the project's migration tool.
   Completion: operation complete, results available.

5. **Format and deliver.**
   Small result (< 20 rows): inline in chat. Large result: write the CSV or JSON under the current `{thread_dir}/attachments/` after applying the Session-attachment rules in `WORKSPACE_FOLDER_STRUCTURE.md`, then attach it with a summary. Destructive write: show affected rows and sample of changes in reply. Schema changes: confirm DDL executed.
   Completion: user received results.

## Branch reference

- Engine-specific connection examples and quirks: `references/engines.md`
- Complex query patterns (JOINs, subqueries, window functions): `references/query.md`
- Backup and restore procedures: `references/backup-restore.md`
- Migration tooling (Prisma, Alembic, Flyway, Django): `references/migrations.md`
- Performance analysis (EXPLAIN, slow queries): `references/performance.md`
- Error diagnosis and recovery: `references/troubleshooting.md`
- Credential handling and least-privilege setup: `references/security.md`

## Constraints

- Never store passwords in plaintext — always encrypted with `DB_ENCRYPTION_KEY`.
- Never emit `PERMISSION_REQUIRED` for a permission already in `have=[...]`.
- Match connection aliases exactly — no fuzzy matching, no guessing.
- Decrypt credentials only at connect time — never log or expose them.
- Close connections after each operation — no persistent connections across turns.
- Show previews for destructive operations (DELETE, DROP, TRUNCATE) before executing.
- Use the Node.js driver wrapper for all engines — no native CLI tools.
- Report errors with engine-specific messages — don't genericize database errors.
- Respect connection `timeout_ms` — abort if connection takes longer.
- Never execute multiple statements in one call unless explicitly requested.
