# Troubleshooting

Error diagnosis and recovery for database operations.

## Connection errors

**Connection refused:**
- Database not running — check service status.
- Wrong host/port — verify connection parameters.
- Firewall blocking — check network rules.
- Docker networking — ensure containers are on the same network.

**Authentication failed:**
- Wrong username/password — verify credentials.
- User doesn't exist — check user was created in the correct database.
- Password expired — check password policy.
- Auth method mismatch — PgBouncer uses different auth than PostgreSQL directly.

**Connection timeout:**
- Network latency — increase `timeout_ms` or check network.
- Database overloaded — check connection count and query load.
- DNS resolution slow — use IP address directly.

**SSL errors:**
- Certificate expired — update CA certificate.
- Hostname mismatch — `sslmode=verify-full` checks the hostname.
- Self-signed cert — add to trust store or use `sslmode=require`.

## Query errors

**Syntax error:**
- Engine-specific syntax — check `references/engines.md` for quirks.
- Reserved words — escape with backticks (MySQL) or double quotes (PostgreSQL).

**Permission denied:**
- User lacks privilege — check `SHOW GRANTS` (MySQL) or `\du` (PostgreSQL).
- Table-level permission — grant on specific table, not just database.

**Deadlock detected:**
- Two transactions waiting on each other — retry one transaction.
- Reduce transaction scope — hold locks for shorter time.
- Lock ordering — always acquire locks in the same order.

**Table/column not found:**
- Wrong database — check `USE database` or connection parameter.
- Wrong schema — use schema-qualified names.
- Case sensitivity — PostgreSQL folds to lowercase, MySQL preserves case.

## Data errors

**Duplicate key violation:**
- INSERT with existing primary key — use ON CONFLICT (PostgreSQL) or ON DUPLICATE KEY (MySQL).
- Unique constraint violation — check existing data before inserting.

**Foreign key violation:**
- Referencing non-existent record — verify parent record exists.
- CASCADE behavior — check ON DELETE/ON UPDATE actions.

**Data truncation:**
- Value too long for column — check column size.
- Type mismatch — ensure value matches column type.

**NULL constraint violation:**
- NOT NULL column receiving NULL — check data completeness.

## Engine-specific

**PostgreSQL:**
- `FATAL: too many connections` — increase `max_connections` or use connection pooling.
- `ERROR: current transaction is aborted` — rollback the failed transaction before retrying.

**MySQL:**
- `Lock wait timeout exceeded` — long-running query holding a lock.
- `Table is full` — check `innodb_file_per_table` and disk space.

**SQLite:**
- `database is locked` — another process has a write lock. Use WAL mode or retry.
- `disk I/O error` — check filesystem and disk space.

**MongoDB:**
- `MongoNetworkError: connect ECONNREFUSED` — MongoDB not running or wrong port.
- `MongoServerError: not authorized` — user lacks database privileges.

**Redis:**
- `NOAUTH Authentication required` — password not provided.
- `OOM command not allowed` — Redis out of memory.

## Recovery steps

1. Read the error message carefully — most contain the exact cause.
2. Check connection parameters (host, port, database, user).
3. Verify the database service is running.
4. Check logs for the database server.
5. Test with a minimal query (`SELECT 1`).
6. If all else fails, check `references/security.md` for credential issues.
