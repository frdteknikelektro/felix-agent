#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR;
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

// Null-safe: computed unconditionally so the module can be imported (e.g. by tests) without
// WORKSPACE_DIR set. The CLI dispatch below verifies the env before any function uses it.
const CONNECTIONS_DIR = WORKSPACE_DIR ? path.join(WORKSPACE_DIR, "databases", "connections") : null;

// Only run the CLI when executed directly (`node query.mjs ...`), not when imported for unit
// tests of the pure helpers (capSelect / writeViolation).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (!WORKSPACE_DIR) fail("WORKSPACE_DIR is not set.");
  if (!DB_ENCRYPTION_KEY) fail("DB_ENCRYPTION_KEY is not set.");

  const [command, ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case "list":
        await listConnections();
        break;
      case "test":
        await testConnection(requireArg(args[0], "alias"));
        break;
      case "query":
        await runQuery(requireArg(args[0], "alias"), await readStdin(), { write: false });
        break;
      case "execute":
        await runQuery(requireArg(args[0], "alias"), await readStdin(), { write: true });
        break;
      case "schema":
        await introspectSchema(requireArg(args[0], "alias"));
        break;
      case "add":
        await addConnection(await readStdin());
        break;
      case "remove":
        await removeConnection(requireArg(args[0], "alias"));
        break;
      default:
        fail("Usage: query.mjs <list|test|query|execute|schema|add|remove>");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// --- Commands ---

async function listConnections() {
  const entries = await fs.readdir(CONNECTIONS_DIR, { withFileTypes: true }).catch(() => []);
  const connections = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(CONNECTIONS_DIR, entry.name), "utf8");
      const conn = JSON.parse(raw);
      connections.push({
        alias: conn.alias,
        engine: conn.engine,
        host: conn.engine_config?.host ?? conn.engine_config?.path ?? conn.engine_config?.account_endpoint ?? "local",
        database: conn.engine_config?.database ?? conn.engine_config?.path ?? null,
        last_tested: conn.last_tested ?? null,
        last_tested_ok: conn.last_tested_ok ?? null,
        tags: conn.tags ?? [],
        notes: conn.notes ?? "",
      });
    } catch {
      // skip malformed files
    }
  }
  output({ connections });
}

async function testConnection(alias) {
  const conn = await loadConnection(alias);
  const driver = await loadDriver(conn.engine);
  const start = Date.now();
  try {
    await driver.test(conn);
    const elapsed = Date.now() - start;
    await updateConnectionMeta(alias, { last_tested: new Date().toISOString(), last_tested_ok: true });
    output({ ok: true, alias, engine: conn.engine, elapsed_ms: elapsed });
  } catch (error) {
    await updateConnectionMeta(alias, { last_tested: new Date().toISOString(), last_tested_ok: false });
    output({ ok: false, alias, engine: conn.engine, error: error.message });
  }
}

async function runQuery(alias, input, opts = { write: false }) {
  const conn = await loadConnection(alias);
  const driver = await loadDriver(conn.engine);
  const { sql, params, max_rows } = input;
  if (!sql) fail("Input must contain 'sql' field.");

  // Defense-in-depth: the `query` command is read-only. A write/DDL statement must be
  // run via `execute` (gated behind the database:write/admin permission tier). This is
  // independent of the tier the caller claims — the wrapper classifies the statement itself.
  if (!opts.write) {
    const violation = writeViolation(conn.engine, sql);
    if (violation) {
      output({ ok: false, alias, engine: conn.engine, error: violation, code: "write_requires_execute" });
      return;
    }
  }

  const start = Date.now();
  try {
    const result = await driver.query(conn, sql, params, { max_rows: max_rows ?? 1000 });
    const elapsed = Date.now() - start;
    output({
      ok: true,
      alias,
      engine: conn.engine,
      rows: result.rows,
      row_count: result.rows.length,
      fields: result.fields,
      elapsed_ms: elapsed,
      truncated: result.truncated ?? false,
    });
  } catch (error) {
    const elapsed = Date.now() - start;
    output({ ok: false, alias, engine: conn.engine, error: error.message, elapsed_ms: elapsed });
  }
}

async function introspectSchema(alias) {
  const conn = await loadConnection(alias);
  const driver = await loadDriver(conn.engine);
  try {
    const schema = await driver.schema(conn);
    output({ ok: true, alias, engine: conn.engine, schema });
  } catch (error) {
    output({ ok: false, alias, engine: conn.engine, error: error.message });
  }
}

async function addConnection(input) {
  const { alias, engine, engine_config, ssh, ssl, timeout_ms, max_connections, tags, notes } = input;
  if (!alias || !engine || !engine_config) fail("Input must contain 'alias', 'engine', and 'engine_config'.");

  const connPath = path.join(CONNECTIONS_DIR, `${alias}.json`);
  if (await pathExists(connPath)) fail(`Connection '${alias}' already exists.`);

  const conn = {
    alias,
    engine,
    created_at: new Date().toISOString(),
    last_tested: null,
    last_tested_ok: null,
    engine_config,
    ssh: ssh ?? null,
    timeout_ms: timeout_ms ?? 10000,
    max_connections: max_connections ?? 5,
    tags: tags ?? [],
    notes: notes ?? "",
  };

  // Encrypt password if present in engine_config
  if (conn.engine_config?.password?.plaintext) {
    conn.engine_config.password = {
      encrypted: encrypt(conn.engine_config.password.plaintext),
    };
  }

  await ensureDir(CONNECTIONS_DIR);
  await fs.writeFile(connPath, JSON.stringify(conn, null, 2), "utf8");
  output({ ok: true, alias, engine, path: connPath });
}

async function removeConnection(alias) {
  const connPath = path.join(CONNECTIONS_DIR, `${alias}.json`);
  if (!(await pathExists(connPath))) fail(`Connection '${alias}' not found.`);
  await fs.unlink(connPath);
  output({ ok: true, alias, removed: connPath });
}

// --- SQL row cap ---

/**
 * For a single SELECT/WITH statement with no trailing LIMIT, append `LIMIT max+1` so the DB
 * caps rows fetched (max+1 is enough to detect truncation) instead of streaming the whole
 * result set into memory. Appending — rather than wrapping in a derived table — keeps queries
 * whose output has duplicate column labels (common with joins / `SELECT *`) valid, since a
 * subquery with duplicate column names is a hard error in Postgres and MySQL.
 *
 * Skipped (returned untouched) for: writes/DDL, multi-statement SQL, a query that already
 * ends in LIMIT, or one ending in a locking clause (FOR UPDATE/SHARE), where LIMIT must
 * precede the lock.
 */
export function capSelect(sql, maxRows) {
  const trimmed = String(sql).trim().replace(/;\s*$/, "");
  const isSingle = !trimmed.includes(";");
  const isSelect = /^(select|with)\b/i.test(trimmed);
  const hasLimit = /\blimit\b\s+\d+\s*$/i.test(trimmed);
  const hasLock = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(trimmed);
  if (isSingle && isSelect && !hasLimit && !hasLock) {
    return `${trimmed} LIMIT ${maxRows + 1}`;
  }
  return sql;
}

// --- Drivers ---

async function loadDriver(engine) {
  switch (engine) {
    case "postgresql":
      return {
        async test(conn) {
          const client = await pgConnect(conn);
          try { await client.query("SELECT 1"); } finally { client.release(); }
        },
        async query(conn, sql, params, opts) {
          const client = await pgConnect(conn);
          try {
            const result = await client.query({ text: capSelect(sql, opts.max_rows), values: params, rowMode: "array" });
            return {
              rows: result.rows.slice(0, opts.max_rows),
              fields: result.fields.map((f) => f.name),
              truncated: result.rows.length > opts.max_rows,
            };
          } finally { client.release(); }
        },
        async schema(conn) {
          const client = await pgConnect(conn);
          try {
            const tables = await client.query(`
              SELECT table_schema, table_name, table_type
              FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              ORDER BY table_schema, table_name
            `);
            const columns = await client.query(`
              SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              ORDER BY table_schema, table_name, ordinal_position
            `);
            return { tables: tables.rows, columns: columns.rows };
          } finally { client.release(); }
        },
      };

    case "mysql":
      return {
        async test(conn) {
          const pool = await mysqlConnect(conn);
          try { await pool.query("SELECT 1"); } finally { pool.end(); }
        },
        async query(conn, sql, params, opts) {
          const pool = await mysqlConnect(conn);
          try {
            const [rows, fields] = await pool.query({ sql: capSelect(sql, opts.max_rows), values: params, timeout: conn.timeout_ms ?? 10000 });
            const arr = Array.isArray(rows) ? rows : [];
            return {
              rows: arr.slice(0, opts.max_rows),
              fields: fields ? fields.map((f) => f.name) : [],
              truncated: arr.length > opts.max_rows,
            };
          } finally { pool.end(); }
        },
        async schema(conn) {
          const pool = await mysqlConnect(conn);
          try {
            const [tables] = await pool.query(`
              SELECT table_schema, table_name, table_type
              FROM information_schema.tables
              WHERE table_schema = DATABASE()
              ORDER BY table_name
            `);
            const [columns] = await pool.query(`
              SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
              WHERE table_schema = DATABASE()
              ORDER BY table_name, ordinal_position
            `);
            return { tables, columns };
          } finally { pool.end(); }
        },
      };

    case "sqlite":
      return {
        async test(conn) {
          const db = await sqliteConnect(conn);
          try { db.prepare("SELECT 1").get(); } finally { db.close(); }
        },
        async query(conn, sql, params, opts) {
          const db = await sqliteConnect(conn);
          try {
            const stmt = db.prepare(sql);
            const rows = stmt.all(params ?? []);
            return {
              rows: rows.slice(0, opts.max_rows),
              fields: rows.length > 0 ? Object.keys(rows[0]) : [],
              truncated: rows.length > opts.max_rows,
            };
          } finally { db.close(); }
        },
        async schema(conn) {
          const db = await sqliteConnect(conn);
          try {
            const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all();
            const columns = [];
            for (const t of tables) {
              const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all();
              for (const c of cols) {
                columns.push({ table_name: t.name, column_name: c.name, data_type: c.type, is_nullable: c.notnull ? "NO" : "YES" });
              }
            }
            return { tables, columns };
          } finally { db.close(); }
        },
      };

    case "mongodb":
      return {
        async test(conn) {
          const client = await mongoConnect(conn);
          try { await client.db().command({ ping: 1 }); } finally { await client.close(); }
        },
        async query(conn, sql, params, opts) {
          const client = await mongoConnect(conn);
          try {
            const db = client.db(conn.engine_config.database);
            // sql is expected to be a JSON string: { "collection": "users", "filter": {...}, "projection": {...} }
            const query = typeof sql === "string" ? JSON.parse(sql) : sql;
            const coll = db.collection(query.collection);
            const rows = await coll.find(query.filter ?? {}).project(query.projection ?? {}).limit(opts.max_rows + 1).toArray();
            const capped = rows.slice(0, opts.max_rows);
            return {
              rows: capped.map((r) => ({ ...r, _id: r._id?.toString() })),
              fields: capped.length > 0 ? Object.keys(capped[0]) : [],
              truncated: rows.length > opts.max_rows,
            };
          } finally { await client.close(); }
        },
        async schema(conn) {
          const client = await mongoConnect(conn);
          try {
            const db = client.db(conn.engine_config.database);
            const collections = await db.listCollections().toArray();
            const schema = {};
            for (const coll of collections) {
              const sample = await db.collection(coll.name).findOne();
              schema[coll.name] = sample ? Object.keys(sample) : [];
            }
            return { collections: collections.map((c) => c.name), schema };
          } finally { await client.close(); }
        },
      };

    case "redis":
      return {
        async test(conn) {
          const client = await redisConnect(conn);
          try { await client.ping(); } finally { client.disconnect(); }
        },
        async query(conn, sql, params, opts) {
          const client = await redisConnect(conn);
          try {
            // sql is expected to be a Redis command: { "command": "GET", "args": ["key"] }
            const cmd = typeof sql === "string" ? JSON.parse(sql) : sql;
            const result = await client.sendCommand([cmd.command, ...(cmd.args ?? [])]);
            return {
              rows: [{ result }],
              fields: ["result"],
            };
          } finally { client.disconnect(); }
        },
        async schema(conn) {
          const client = await redisConnect(conn);
          try {
            const info = await client.info("keyspace");
            return { info };
          } finally { client.disconnect(); }
        },
      };

    case "dynamodb":
      return {
        async test(conn) {
          const { DynamoDBClient, ListTablesCommand } = await import("@aws-sdk/client-dynamodb");
          const client = await dynamoClient(conn);
          await client.send(new ListTablesCommand({}));
        },
        async query(conn, sql, params, opts) {
          const { DynamoDBClient, ScanCommand, QueryCommand } = await import("@aws-sdk/client-dynamodb");
          const client = await dynamoClient(conn);
          // sql is expected to be: { "table": "users", "operation": "scan"|"query", ... }
          const query = typeof sql === "string" ? JSON.parse(sql) : sql;
          let command;
          if (query.operation === "query") {
            command = new QueryCommand({
              TableName: query.table,
              KeyConditionExpression: query.key_condition,
              ExpressionAttributeValues: query.values,
              Limit: opts.max_rows,
            });
          } else {
            command = new ScanCommand({
              TableName: query.table,
              FilterExpression: query.filter,
              ExpressionAttributeValues: query.values,
              Limit: opts.max_rows,
            });
          }
          const result = await client.send(command);
          return {
            rows: result.Items ?? [],
            fields: result.Items?.length > 0 ? Object.keys(result.Items[0]) : [],
            count: result.Count,
            scanned_count: result.ScannedCount,
            truncated: !!result.LastEvaluatedKey,
          };
        },
        async schema(conn) {
          const { DynamoDBClient, ListTablesCommand, DescribeTableCommand } = await import("@aws-sdk/client-dynamodb");
          const client = await dynamoClient(conn);
          const tables = await client.send(new ListTablesCommand({}));
          const schema = {};
          for (const tableName of (tables.TableNames ?? [])) {
            const desc = await client.send(new DescribeTableCommand({ TableName: tableName }));
            schema[tableName] = {
              key_schema: desc.Table?.KeySchema,
              item_count: desc.Table?.ItemCount,
              status: desc.Table?.TableStatus,
            };
          }
          return { tables: tables.TableNames ?? [], schema };
        },
      };

    case "cosmos":
      return {
        async test(conn) {
          const { CosmosClient } = await import("@azure/cosmos");
          const client = await cosmosClient(conn);
          await client.getDatabaseAccount();
        },
        async query(conn, sql, params, opts) {
          const { CosmosClient } = await import("@azure/cosmos");
          const client = await cosmosClient(conn);
          const database = client.database(conn.engine_config.database);
          const container = database.container(conn.engine_config.container);
          const querySpec = typeof sql === "string" ? { query: sql, parameters: params } : sql;
          const { resources } = await container.items.query(querySpec).fetchNext();
          return {
            rows: resources.slice(0, opts.max_rows),
            fields: resources.length > 0 ? Object.keys(resources[0]) : [],
            truncated: resources.length > opts.max_rows,
          };
        },
        async schema(conn) {
          const { CosmosClient } = await import("@azure/cosmos");
          const client = await cosmosClient(conn);
          const database = client.database(conn.engine_config.database);
          const { resources: containers } = await database.containers.readAll().fetchAll();
          const schema = {};
          for (const c of containers) {
            schema[c.id] = { partition_key: c.partitionKey, indexing_policy: c.indexingPolicy };
          }
          return { containers: containers.map((c) => c.id), schema };
        },
      };

    default:
      fail(`Unsupported engine: ${engine}`);
  }
}

// --- Connection helpers ---

async function loadConnection(alias) {
  const connPath = path.join(CONNECTIONS_DIR, `${alias}.json`);
  if (!(await pathExists(connPath))) fail(`Connection '${alias}' not found.`);
  const raw = await fs.readFile(connPath, "utf8");
  return JSON.parse(raw);
}

async function updateConnectionMeta(alias, meta) {
  const connPath = path.join(CONNECTIONS_DIR, `${alias}.json`);
  if (!(await pathExists(connPath))) return;
  const conn = JSON.parse(await fs.readFile(connPath, "utf8"));
  Object.assign(conn, meta);
  await fs.writeFile(connPath, JSON.stringify(conn, null, 2), "utf8");
}

// --- Encryption ---

function encrypt(plaintext) {
  const key = Buffer.from(DB_ENCRYPTION_KEY, "base64");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted}`;
}

function decrypt(encryptedStr) {
  const key = Buffer.from(DB_ENCRYPTION_KEY, "base64");
  const parts = String(encryptedStr ?? "").split(":");
  if (parts.length !== 3) fail("Encrypted value must be 'iv:tag:ciphertext'.");
  const [ivB64, tagB64, encrypted] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getPassword(conn) {
  const pw = conn.engine_config?.password;
  if (!pw) return undefined;
  if (pw.plaintext) return pw.plaintext;
  if (pw.encrypted) return decrypt(pw.encrypted);
  return undefined;
}

// --- Driver connectors ---

async function pgConnect(conn) {
  const { Pool } = await import("pg");
  const pool = new Pool({
    host: conn.engine_config.host,
    port: conn.engine_config.port ?? 5432,
    database: conn.engine_config.database,
    user: conn.engine_config.user,
    password: getPassword(conn),
    ssl: conn.engine_config.ssl
      ? { rejectUnauthorized: conn.engine_config.ssl_reject_unauthorized !== false, ca: conn.engine_config.ssl_ca }
      : false,
    connectionTimeoutMillis: conn.timeout_ms ?? 10000,
    max: conn.max_connections ?? 5,
    application_name: conn.engine_config.application_name ?? "felix-agent",
  });
  return pool.connect();
}

async function mysqlConnect(conn) {
  const mysql = await import("mysql2/promise");
  return mysql.createPool({
    host: conn.engine_config.host,
    port: conn.engine_config.port ?? 3306,
    database: conn.engine_config.database,
    user: conn.engine_config.user,
    password: getPassword(conn),
    charset: conn.engine_config.charset ?? "utf8mb4",
    ssl: (conn.engine_config.ssl || conn.engine_config.ssl_ca)
      ? { ca: conn.engine_config.ssl_ca, rejectUnauthorized: conn.engine_config.ssl_reject_unauthorized !== false }
      : undefined,
    connectTimeout: conn.timeout_ms ?? 10000,
    waitForConnections: true,
    connectionLimit: conn.max_connections ?? 5,
  });
}

async function sqliteConnect(conn) {
  const Database = (await import("better-sqlite3")).default;
  const dbPath = conn.engine_config.path;
  const db = new Database(dbPath, { readonly: conn.engine_config.readonly ?? false, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  return db;
}

async function mongoConnect(conn) {
  const { MongoClient } = await import("mongodb");
  const uri = conn.engine_config.connection_string;
  const client = new MongoClient(uri, {
    connectTimeoutMS: conn.timeout_ms ?? 10000,
    serverSelectionTimeoutMS: conn.timeout_ms ?? 10000,
  });
  await client.connect();
  return client;
}

async function redisConnect(conn) {
  const { Redis } = await import("ioredis");
  const client = new Redis({
    host: conn.engine_config.host,
    port: conn.engine_config.port ?? 6379,
    password: getPassword(conn),
    db: conn.engine_config.database ?? 0,
    tls: conn.engine_config.tls ? {} : undefined,
    connectTimeout: conn.timeout_ms ?? 10000,
    maxRetriesPerRequest: 1,
  });
  return client;
}

async function dynamoClient(conn) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const config = {
    region: conn.engine_config.region,
    credentials: {
      accessKeyId: decrypt(conn.engine_config.access_key.encrypted),
      secretAccessKey: decrypt(conn.engine_config.secret_key.encrypted),
    },
  };
  if (conn.engine_config.endpoint_override) {
    config.endpoint = conn.engine_config.endpoint_override;
  }
  return new DynamoDBClient(config);
}

async function cosmosClient(conn) {
  const { CosmosClient } = await import("@azure/cosmos");
  return new CosmosClient({
    endpoint: conn.engine_config.account_endpoint,
    key: decrypt(conn.engine_config.primary_key.encrypted),
  });
}

// --- Read/write classification (defense-in-depth for permission tiers) ---

const SQL_READ_LEADERS = new Set([
  "select", "with", "show", "explain", "describe", "desc", "pragma", "values", "table",
]);

// Only scanned inside WITH ... statements (a CTE can wrap a data-modifying INSERT/UPDATE
// in Postgres). Non-WITH statements are classified by their leading keyword alone, so a
// string literal like WHERE col = 'set' never trips a false positive.
const SQL_WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|replace|merge|call|exec|execute|attach|detach|vacuum|reindex|lock|copy|upsert|rename)\b/i;

const REDIS_READ_COMMANDS = new Set([
  "get", "mget", "strlen", "getrange", "getbit", "bitcount", "exists", "ttl", "pttl", "type",
  "keys", "scan", "randomkey", "dbsize", "object", "memory",
  "hget", "hmget", "hgetall", "hkeys", "hvals", "hlen", "hexists",
  "lrange", "llen", "lindex",
  "smembers", "scard", "sismember", "srandmember", "sinter", "sunion", "sdiff",
  "zrange", "zrevrange", "zrangebyscore", "zscore", "zcard", "zrank", "zrevrank", "zcount",
  "xrange", "xlen", "geopos", "geodist", "info", "ping",
]);

/** Returns a message if `sql` is a write/DDL on a read-only path, else null. */
export function writeViolation(engine, sql) {
  if (engine === "postgresql" || engine === "mysql" || engine === "sqlite") return sqlWriteViolation(sql);
  if (engine === "redis") return redisWriteViolation(sql);
  // mongo/dynamo/cosmos query paths only implement reads (find / scan / query).
  return null;
}

function sqlWriteViolation(sql) {
  const text = String(sql)
    .replace(/--[^\n]*/g, " ")          // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // strip block comments
    .trim();
  if (!text) return null;
  for (const stmt of text.split(";").map((s) => s.trim()).filter(Boolean)) {
    const leader = (stmt.match(/^[a-zA-Z]+/) ?? [""])[0].toLowerCase();
    if (!SQL_READ_LEADERS.has(leader)) {
      return `Statement '${leader || stmt.slice(0, 20)}' is not read-only; use 'execute' (requires database:write/admin).`;
    }
    if (leader === "with" && SQL_WRITE_KEYWORDS.test(stmt)) {
      return "CTE contains a write/DDL statement; use 'execute' (requires database:write/admin).";
    }
  }
  return null;
}

function redisWriteViolation(sql) {
  let cmd;
  try {
    cmd = typeof sql === "string" ? JSON.parse(sql) : sql;
  } catch {
    return "Invalid Redis command JSON.";
  }
  const name = String(cmd?.command ?? "").toLowerCase();
  if (!name) return "Redis command missing 'command'.";
  if (!REDIS_READ_COMMANDS.has(name)) {
    return `Redis command '${name.toUpperCase()}' is not read-only; use 'execute' (requires database:write/admin).`;
  }
  return null;
}

// --- Utilities ---

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

function output(data) {
  console.log(JSON.stringify(data));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function requireArg(value, name) {
  if (!value) fail(`Missing required argument: ${name}`);
  return value;
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
