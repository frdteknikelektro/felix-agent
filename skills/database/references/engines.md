# Engines

Connection examples and quirks per database engine.

## PostgreSQL

```json
{
  "alias": "prod-pg",
  "engine": "postgresql",
  "engine_config": {
    "host": "db.example.com",
    "port": 5432,
    "database": "myapp",
    "user": "felix",
    "password": { "encrypted": "base64..." },
    "ssl": true,
    "ssl_ca": "/path/to/ca.pem",
    "default_schema": "public",
    "application_name": "felix-agent"
  }
}
```

Quirks:
- `application_name` shows in `pg_stat_activity` — useful for identifying Felix connections.
- SSL modes: `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`. Default `require` in the driver.
- Schema-qualified queries: `SELECT * FROM public.users` — include schema when multiple schemas exist.

## MySQL / MariaDB

```json
{
  "alias": "staging-mysql",
  "engine": "mysql",
  "engine_config": {
    "host": "db.example.com",
    "port": 3306,
    "database": "myapp",
    "user": "felix",
    "password": { "encrypted": "base64..." },
    "charset": "utf8mb4",
    "collation": "utf8mb4_unicode_ci",
    "ssl_ca": "/path/to/ca.pem"
  }
}
```

Quirks:
- Always use `utf8mb4` charset — `utf8` is a 3-byte subset that doesn't support emoji.
- `GROUP BY` behavior differs from PostgreSQL — MySQL allows non-aggregated columns in `GROUP BY` without error.
- `LIMIT` syntax: `LIMIT offset, count` (MySQL) vs `LIMIT count OFFSET offset` (PostgreSQL).

## SQLite

```json
{
  "alias": "local-analytics",
  "engine": "sqlite",
  "engine_config": {
    "path": "/data/analytics.db",
    "password": { "encrypted": "base64..." },
    "readonly": false
  }
}
```

Quirks:
- No network connection — file-based. Path must be accessible from the container.
- No user management or grants — file permissions are the access control.
- WAL mode recommended for concurrent reads: `PRAGMA journal_mode=WAL;`
- Type affinity is flexible — column types are hints, not constraints.

## MongoDB

```json
{
  "alias": "analytics-mongo",
  "engine": "mongodb",
  "engine_config": {
    "connection_string": "mongodb://user:pass@host:27017",
    "auth_database": "admin",
    "replica_set": "rs0",
    "ssl": true,
    "direct_connection": false
  }
}
```

Quirks:
- `connection_string` can include all parameters — `engine_config` fields override if both present.
- `auth_database` is the database where the user was created, not necessarily the target database.
- `direct_connection: true` bypasses replica set discovery — useful for diagnostics, not for normal operations.

## Redis

```json
{
  "alias": "cache",
  "engine": "redis",
  "engine_config": {
    "host": "redis.example.com",
    "port": 6379,
    "password": { "encrypted": "base64..." },
    "database": 0,
    "tls": true
  }
}
```

Quirks:
- `database` is a number (0-15 by default). Redis doesn't have named databases.
- No SQL — use Redis commands (GET, SET, HGETALL, LRANGE, etc.).
- Key patterns: `user:123:profile`, `session:abc123`. Ask the user about key naming conventions.

## DynamoDB

```json
{
  "alias": "users-dynamo",
  "engine": "dynamodb",
  "engine_config": {
    "region": "us-east-1",
    "access_key": { "encrypted": "base64..." },
    "secret_key": { "encrypted": "base64..." },
    "endpoint_override": "http://localhost:8000",
    "table_prefix": "myapp-"
  }
}
```

Quirks:
- No SQL — use DynamoDB operations (GetItem, PutItem, Query, Scan).
- `endpoint_override` is for local development (DynamoDB Local).
- `table_prefix` is prepended to table names in commands — avoids prefixing every query.
- Partition key + sort key model — understand the table's key schema before querying.

## Cosmos DB

```json
{
  "alias": "events-cosmos",
  "engine": "cosmos",
  "engine_config": {
    "account_endpoint": "https://myaccount.documents.azure.com:443/",
    "primary_key": { "encrypted": "base64..." },
    "database": "mydb",
    "container": "mycontainer",
    "consistency_level": "Session"
  }
}
```

Quirks:
- No native CLI — uses `@azure/cosmos` Node.js SDK.
- `consistency_level` options: `Strong`, `BoundedStaleness`, `Session`, `Prefix`, `Eventual`.
- Partition key is defined at container creation — queries should include the partition key for performance.
- RU (Request Unit) consumption matters — `SELECT * FROM c` is expensive; use point queries.
