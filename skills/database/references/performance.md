# Performance

Query performance analysis and optimization.

## EXPLAIN plans

PostgreSQL:
```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'alice@example.com';
```
Shows: execution time, rows scanned, index usage, join strategy.

MySQL:
```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'alice@example.com';
-- Or: EXPLAIN FORMAT=JSON SELECT ...;
```
Shows: select_type, type (ALL=index scan, ref=index lookup), key, rows.

## Reading EXPLAIN output

Key things to look for:
- **Seq Scan / ALL** — full table scan. Missing index or small table.
- **Index Scan / index** — using an index. Good.
- **Nested Loop** — fine for small result sets, bad for large.
- **Hash Join / Merge Join** — efficient for large result sets.
- **Sort** — consider adding an index on the ORDER BY column.

## Common performance issues

1. **Missing indexes:**
   ```sql
   -- Find slow queries (PostgreSQL)
   SELECT query, calls, mean_time, total_time
   FROM pg_stat_statements
   ORDER BY mean_time DESC
   LIMIT 10;
   
   -- Find missing indexes (PostgreSQL)
   SELECT schemaname, tablename, attname, n_distinct, correlation
   FROM pg_stats
   WHERE tablename = 'users' AND n_distinct > 100;
   ```

2. **N+1 queries:**
   - Symptom: many similar queries with different parameters.
   - Fix: batch queries or use JOINs.

3. **SELECT *:**
   - Fetches all columns, even unused ones.
   - Fix: specify only needed columns.

4. **Large OFFSET:**
   - `LIMIT 10 OFFSET 10000` scans 10,010 rows.
   - Fix: cursor-based pagination using a stable column.

5. **Implicit type casting:**
   - PostgreSQL: `WHERE id = '123'` (string vs integer) prevents index usage.
   - Fix: use correct types.

## Monitoring queries

PostgreSQL:
```sql
-- Active queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active' AND now() - pg_stat_activity.query_start > interval '5 minutes';

-- Table statistics
SELECT relname, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del
FROM pg_stat_user_tables
ORDER BY seq_scan DESC;
```

MySQL:
```sql
-- Active queries
SHOW PROCESSLIST;
SHOW FULL PROCESSLIST;

-- Slow query log
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 2;
```

## Index strategy

- Index columns used in WHERE, JOIN, and ORDER BY.
- Composite indexes: column order matters (equality first, range last).
- Partial indexes (PostgreSQL): `CREATE INDEX idx ON users (email) WHERE active = true;`
- Avoid over-indexing: each index slows writes.

## Connection pooling

- Don't open/close connections per query — use a pool.
- Default pool sizes: 5-10 connections per service.
- Monitor connection count: too many connections exhaust database resources.
