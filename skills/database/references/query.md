# Query patterns

Complex SQL patterns and engine-specific query syntax.

## JOINs

PostgreSQL:
```sql
SELECT u.name, o.total
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE o.created_at > now() - interval '30 days';
```

MySQL:
```sql
SELECT u.name, o.total
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE o.created_at > date_sub(now(), interval 30 day);
```

## Window functions

PostgreSQL:
```sql
SELECT name, department, salary,
  RANK() OVER (PARTITION BY department ORDER BY salary DESC) as dept_rank
FROM employees;
```

MySQL 8+:
```sql
-- Same syntax as PostgreSQL
```

## Common table expressions

```sql
WITH active_users AS (
  SELECT id, name FROM users WHERE last_login > now() - interval '90 days'
)
SELECT au.name, COUNT(o.id) as order_count
FROM active_users au
LEFT JOIN orders o ON o.user_id = au.id
GROUP BY au.id, au.name;
```

## JSON queries

PostgreSQL:
```sql
SELECT * FROM events WHERE payload->>'type' = 'purchase';
SELECT payload->'items'->0->>'name' FROM orders;
```

MySQL:
```sql
SELECT * FROM events WHERE JSON_EXTRACT(payload, '$.type') = 'purchase';
-- Or shorthand:
SELECT * FROM events WHERE payload->'$.type' = 'purchase';
```

## Aggregation patterns

```sql
-- Date bucketing
SELECT date_trunc('day', created_at) as day, COUNT(*)
FROM events
GROUP BY day
ORDER BY day DESC;

-- Running total
SELECT date, amount,
  SUM(amount) OVER (ORDER BY date) as running_total
FROM daily_sales;
```

## MongoDB queries

```javascript
// Find with filter
db.users.find({ status: "active", age: { $gte: 18 } })

// Aggregation pipeline
db.orders.aggregate([
  { $match: { created_at: { $gte: ISODate("2025-01-01") } } },
  { $group: { _id: "$user_id", total: { $sum: "$amount" } } },
  { $sort: { total: -1 } },
  { $limit: 10 }
])
```

## Redis commands

```
-- Key-value
GET user:123:name
SET user:123:name "Alice"

-- Hashes
HGETALL user:123
HSET user:123 name "Alice" email "alice@example.com"

-- Lists
LRANGE queue:tasks 0 -1
RPUSH queue:tasks "task1"

-- Sets
SMEMBERS tags:post:456
SADD tags:post:456 "javascript" "nodejs"

-- Sorted sets
ZREVRANGE leaderboard 0 9 WITHSCORES
ZADD leaderboard 1500 "player1"
```

## DynamoDB operations

```
// GetItem
aws dynamodb get-item --table-name users --key '{"id": {"S": "123"}}'

// Query (requires partition key)
aws dynamodb query --table-name orders \
  --key-condition-expression "user_id = :uid" \
  --expression-attribute-values '{":uid": {"S": "123"}}'

// Scan (avoid on large tables)
aws dynamodb scan --table-name users --limit 100
```
