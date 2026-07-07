import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM skill script, no type declarations
import { capSelect, writeViolation } from "../skills/database/query.mjs";

describe("capSelect", () => {
  it("appends LIMIT max+1 to a bare SELECT", () => {
    expect(capSelect("SELECT * FROM users", 1000)).toBe("SELECT * FROM users LIMIT 1001");
  });

  it("appends to WITH ... SELECT", () => {
    expect(capSelect("WITH c AS (SELECT 1) SELECT * FROM c", 10)).toBe(
      "WITH c AS (SELECT 1) SELECT * FROM c LIMIT 11",
    );
  });

  it("does NOT wrap in a derived table (joins with duplicate column names stay valid)", () => {
    const joined = "SELECT * FROM orders o JOIN users u ON u.id = o.user_id";
    const out = capSelect(joined, 500);
    expect(out).toBe(`${joined} LIMIT 501`);
    expect(out).not.toContain("_capped");
    expect(out).not.toMatch(/^SELECT \* FROM \(/);
  });

  it("strips a trailing semicolon before appending", () => {
    expect(capSelect("SELECT 1;", 5)).toBe("SELECT 1 LIMIT 6");
  });

  it("leaves a query that already has a trailing LIMIT untouched", () => {
    expect(capSelect("SELECT * FROM t LIMIT 50", 1000)).toBe("SELECT * FROM t LIMIT 50");
  });

  it("leaves a locking SELECT untouched (LIMIT must precede FOR UPDATE)", () => {
    const q = "SELECT * FROM jobs WHERE state = 'ready' FOR UPDATE";
    expect(capSelect(q, 1000)).toBe(q);
  });

  it("leaves multi-statement SQL untouched", () => {
    const q = "SELECT 1; SELECT 2";
    expect(capSelect(q, 1000)).toBe(q);
  });

  it("leaves writes/DDL untouched", () => {
    expect(capSelect("UPDATE t SET x = 1", 1000)).toBe("UPDATE t SET x = 1");
    expect(capSelect("INSERT INTO t VALUES (1)", 1000)).toBe("INSERT INTO t VALUES (1)");
  });
});

describe("writeViolation", () => {
  it("allows reads on SQL engines", () => {
    expect(writeViolation("postgresql", "SELECT * FROM t")).toBeNull();
    expect(writeViolation("mysql", "  select 1")).toBeNull();
    expect(writeViolation("sqlite", "PRAGMA table_info(x)")).toBeNull();
  });

  it("blocks writes/DDL on SQL engines with a write_requires_execute-style message", () => {
    expect(writeViolation("postgresql", "DROP TABLE users")).toMatch(/not read-only/);
    expect(writeViolation("mysql", "delete from t")).toMatch(/not read-only/);
  });

  it("blocks a data-modifying CTE", () => {
    const cte = "WITH c AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM c";
    expect(writeViolation("postgresql", cte)).toMatch(/CTE contains a write/);
  });

  it("does not false-positive on string literals containing write keywords", () => {
    expect(writeViolation("postgresql", "SELECT * FROM t WHERE note = 'reset the counter'")).toBeNull();
    expect(writeViolation("postgresql", "SELECT * FROM t WHERE s = 'set'")).toBeNull();
  });

  it("blocks a comment-hidden write via the leading keyword check", () => {
    // leading token is `SELECT`, so this specific case is allowed — the DROP is inside a comment
    expect(writeViolation("postgresql", "-- drop table t\nSELECT 1")).toBeNull();
    // but a real trailing statement is caught
    expect(writeViolation("postgresql", "SELECT 1; DROP TABLE t")).toMatch(/not read-only/);
  });

  it("enforces a Redis read-command allowlist", () => {
    expect(writeViolation("redis", JSON.stringify({ command: "GET", args: ["k"] }))).toBeNull();
    expect(writeViolation("redis", JSON.stringify({ command: "SET", args: ["k", "v"] }))).toMatch(/not read-only/);
    expect(writeViolation("redis", JSON.stringify({ args: [] }))).toMatch(/missing 'command'/);
  });

  it("treats mongo/dynamo/cosmos query paths as read-only", () => {
    expect(writeViolation("mongodb", JSON.stringify({ collection: "u" }))).toBeNull();
    expect(writeViolation("dynamodb", JSON.stringify({ table: "u", operation: "scan" }))).toBeNull();
    expect(writeViolation("cosmos", "SELECT * FROM c")).toBeNull();
  });
});
