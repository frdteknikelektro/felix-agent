---
id: database
name: Database
description: >-
  Manage and query database connections. Use when the user mentions databases,
  tables, queries, SQL, connections, schemas, backup, migration, or wants to
  inspect, query, backup, or migrate data.
version: 1
enabled: true
kind: operational
permissions:
  - read
  - write
  - admin
match:
  - database
  - query
  - sql
  - table
  - connection
  - schema
  - backup
  - migration
---

# Database

## Permissions

- `read` — SELECT, SHOW, DESCRIBE, EXPLAIN, schema introspection.
- `write` — INSERT, UPDATE, DELETE, DDL (CREATE/ALTER/DROP).
- `admin` — CREATE/DROP DATABASE, GRANT, REVOKE, user management, backups.

Each permission scopes to a connection alias or wildcard:

- `database:read.prod-pg` — read access to one connection.
- `database:write.staging-*` — write access to connections matching pattern.
- `database:read.*` — read access to all connections.

Wildcard matching: `database:read.*` matches any `database:read.<alias>`. The contact's `allowed_permissions` is checked at runtime — the server-computed `permissions_per_skill` block is authoritative for base permissions; connection-specific checks are skill-resolved.

Emit `PERMISSION_REQUIRED` with the narrowest permission the current operation needs.

## Execution

1. **Resolve the target connection.**
   Read `workspace/databases/connections/` and match by alias, engine, host, or database name. If multiple matches, list candidates and ask the user to clarify. If no matches, list available connections.
   Completion: exactly one connection file resolved, or user corrected the target.

2. **Check permission.**
   Determine the operation type (read, write, admin) and check the contact's `allowed_permissions` for `database:<tier>.<alias>` or `database:<tier>.*`. If the server-computed `permissions_per_skill` block shows `have=[...]` with the base permission, proceed to connection-specific check. If missing, emit `PERMISSION_REQUIRED` and stop.
   Completion: permission verified or `PERMISSION_REQUIRED` emitted.

3. **Establish connection.**
   Read the connection file. Decrypt password using `DB_ENCRYPTION_KEY` via the query wrapper script. If the connection has an `ssh` block, open the tunnel first via the `ssh` skill, then point the connection at the tunnel's **local bind** (e.g. `127.0.0.1:<local_port>`) — do not dial the remote `host` directly. Connect to engine. Test connectivity.
   Completion: connection alive, ready to execute.

4. **Execute the operation.**
   Run the operation through the Node.js driver wrapper (`skills/database/query.mjs`). Use the `query` command for reads and `execute` for writes/DDL — `query` is enforced read-only by the wrapper (it rejects INSERT/UPDATE/DELETE/DDL and non-read Redis commands with `write_requires_execute`), so a `read`-tier operation cannot mutate data even if misclassified. Only call `execute` after a `database:write.<alias>` / `database:admin.<alias>` permission check. For schema introspection, use the `schema` command. For backups, use engine-specific dump commands. For migrations, run the project's migration tool.
   Completion: operation complete, results available.

5. **Format and deliver.**
   Small result (< 20 rows): inline in chat. Large result: write to `<thread_dir>/attachments/` as CSV or JSON, attach with summary. Destructive write: show affected rows and sample of changes in reply. Schema changes: confirm DDL executed.
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
