# Backup and restore

Engine-specific backup and restore procedures.

## PostgreSQL

Backup:
```bash
pg_dump -h HOST -U USER -d DATABASE -F c -f backup.dump
# Compressed: pg_dump ... | gzip > backup.sql.gz
# Schema only: pg_dump ... --schema-only -f schema.sql
# Data only: pg_dump ... --data-only -f data.sql
```

Restore:
```bash
pg_restore -h HOST -U USER -d DATABASE backup.dump
# From SQL: psql -h HOST -U USER -d DATABASE < backup.sql
```

Quirks:
- `-F c` creates a custom-format dump (compressed, restoreable with `pg_restore`).
- `--no-owner` avoids permission issues when restoring to a different user.
- Large databases: use `pg_dump -j 4` for parallel dump (4 jobs).

## MySQL / MariaDB

Backup:
```bash
mysqldump -h HOST -u USER -p DATABASE > backup.sql
# Single table: mysqldump ... DATABASE table_name > table.sql
# Schema only: mysqldump ... --no-data > schema.sql
# All databases: mysqldump --all-databases > all.sql
```

Restore:
```bash
mysql -h HOST -u USER -p DATABASE < backup.sql
```

Quirks:
- `--single-transaction` for InnoDB consistency without locking.
- `--routines --triggers --events` to include stored procedures.
- `--default-character-set=utf8mb4` to preserve encoding.

## SQLite

Backup:
```bash
sqlite3 source.db ".backup backup.db"
# Or: cp source.db backup.db (safe if no active writes)
```

Restore:
```bash
sqlite3 new.db < backup.sql
# Or: cp backup.db new.db
```

Quirks:
- SQLite has no dump command — file copy is the backup method.
- `.dump` exports as SQL: `sqlite3 source.db .dump > backup.sql`
- WAL mode: checkpoint before backup: `PRAGMA wal_checkpoint;`

## MongoDB

Backup:
```bash
mongodump --host HOST --port PORT --username USER --password PASS --out /backup/
# Single database: mongodump --db DATABASE --out /backup/
# Single collection: mongodump --db DATABASE --collection COLLECTION --out /backup/
```

Restore:
```bash
mongorestore --host HOST --port PORT --username USER --password PASS /backup/
```

Quirks:
- `--gzip` for compressed dumps.
- `--oplog` for point-in-time consistency in replica sets.
- Atlas: use `mongodump` with `--uri` connection string.

## Redis

Backup:
```bash
redis-cli -h HOST -p PORT -a PASSWORD BGSAVE
# Wait for completion: redis-cli LASTSAVE
# Copy dump.rdb from Redis data directory
```

Restore:
```bash
# Stop Redis, copy dump.rdb to data directory, restart Redis
```

Quirks:
- Redis backup is a point-in-time snapshot of the in-memory data.
- `BGSAVE` forks a child process — non-blocking but uses memory.
- AOF (Append Only File) is another backup method: `BGREWRITEAOF`.

## DynamoDB

Backup:
```bash
aws dynamodb create-backup --table-name TABLE --backup-name BACKUP_NAME
# List backups: aws dynamodb list-backups
# Export to S3: aws dynamodb export-table-to-point-in-time ...
```

Restore:
```bash
aws dynamodb restore-table-from-backup --target-table-name NEW_TABLE --backup-arn ARN
```

Quirks:
- On-demand backups are immediate and don't affect performance.
- Point-in-time recovery (PITR) enables restore to any second in the last 35 days.
- Export to S3 for cross-region or cross-account restore.

## Cosmos DB

Backup:
```bash
# Continuous backup mode: PITR is automatic
# Periodic backup: configured at account level
# Manual: use Azure CLI
az cosmosdb sql database backup --account-name ACCOUNT --name DATABASE
```

Restore:
```bash
# Restore from continuous backup via Azure portal or CLI
az cosmosdb sql database restore --account-name ACCOUNT --name DATABASE --restore-timestamp TIMESTAMP
```

Quirks:
- Continuous backup mode enables PITR to any second in the last 30 days.
- Periodic backup: snapshots every 4 hours, retained for configurable period.
- Cross-region restore is supported for continuous backup mode.
