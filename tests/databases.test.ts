import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  encryptPassword,
  decryptPassword,
  encryptEngineConfigSecrets,
  normalizeConnectionInput,
  DatabaseError,
} from "../src/slices/databases/index.js";
import {
  createDatabaseConnection,
  updateDatabaseConnection,
} from "../src/owner-data.js";
import type { AppConfig } from "../src/config.js";
import { buildWorkspacePaths } from "../src/workspace.js";

beforeAll(() => {
  // 32-byte key, base64 → valid aes-256-gcm key
  process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

async function makeCfg(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-db-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  return {
    WORKSPACE_DIR: workspace,
    paths: buildWorkspacePaths(workspace),
  } as never;
}

function connFile(cfg: AppConfig, alias: string): string {
  return path.join(cfg.paths.root, "databases", "connections", `${alias}.json`);
}

describe("password encryption", () => {
  it("roundtrips plaintext through encrypt/decrypt", () => {
    const secret = "s3cr3t-p@ss";
    const enc = encryptPassword(secret);
    expect(enc).toMatch(/^[^:]+:[^:]+:[^:]+$/);
    expect(enc).not.toContain(secret);
    expect(decryptPassword(enc)).toBe(secret);
  });

  it("rejects malformed ciphertext instead of throwing on Buffer.from(undefined)", () => {
    expect(() => decryptPassword("not-a-valid-blob")).toThrow(DatabaseError);
  });
});

describe("encryptEngineConfigSecrets", () => {
  it("encrypts an incoming plaintext password", () => {
    const out = encryptEngineConfigSecrets({ host: "db", password: { plaintext: "hunter2" } });
    const pw = out["password"] as { encrypted?: string; plaintext?: string };
    expect(pw.plaintext).toBeUndefined();
    expect(typeof pw.encrypted).toBe("string");
    expect(decryptPassword(pw.encrypted as string)).toBe("hunter2");
  });

  it("preserves the existing encrypted password when incoming is blank", () => {
    const existingEnc = encryptPassword("keep-me");
    const out = encryptEngineConfigSecrets(
      { host: "db" },
      { host: "db", password: { encrypted: existingEnc } },
    );
    expect((out["password"] as { encrypted: string }).encrypted).toBe(existingEnc);
  });

  it("drops the password field when neither incoming nor existing has one", () => {
    const out = encryptEngineConfigSecrets({ host: "db" });
    expect(out["password"]).toBeUndefined();
  });
});

describe("normalizeConnectionInput", () => {
  it("applies defaults for timeout, max_connections and tags", () => {
    const n = normalizeConnectionInput({ engine: "postgresql" });
    expect(n.engine).toBe("postgresql");
    expect(n.timeout_ms).toBe(10000);
    expect(n.max_connections).toBe(5);
    expect(n.tags).toEqual([]);
    expect(n.ssh).toBeNull();
  });
});

describe("createDatabaseConnection", () => {
  it("persists an encrypted password, never plaintext", async () => {
    const cfg = await makeCfg();
    await createDatabaseConnection(cfg, "prod-pg", {
      engine: "postgresql",
      engine_config: { host: "db", user: "app", password: { plaintext: "topsecret" } },
    });

    const raw = await fs.readFile(connFile(cfg, "prod-pg"), "utf8");
    expect(raw).not.toContain("topsecret");
    expect(raw).not.toContain("plaintext");

    const stored = JSON.parse(raw);
    expect(decryptPassword(stored.engine_config.password.encrypted)).toBe("topsecret");
  });

  it("rejects a duplicate alias", async () => {
    const cfg = await makeCfg();
    await createDatabaseConnection(cfg, "dup", { engine: "sqlite", engine_config: { path: "/tmp/x.db" } });
    await expect(
      createDatabaseConnection(cfg, "dup", { engine: "sqlite", engine_config: { path: "/tmp/x.db" } }),
    ).rejects.toThrow("connection_exists");
  });
});

describe("updateDatabaseConnection", () => {
  it("keeps the existing password when the edit leaves it blank", async () => {
    const cfg = await makeCfg();
    await createDatabaseConnection(cfg, "edit-me", {
      engine: "postgresql",
      engine_config: { host: "db", user: "app", password: { plaintext: "orig-pass" } },
    });

    // edit only tags/notes — no password field (UI sends undefined on blank)
    await updateDatabaseConnection(cfg, "edit-me", {
      engine: "postgresql",
      engine_config: { host: "db", user: "app" },
      tags: ["prod"],
      notes: "primary",
    });

    const stored = JSON.parse(await fs.readFile(connFile(cfg, "edit-me"), "utf8"));
    expect(stored.tags).toEqual(["prod"]);
    expect(decryptPassword(stored.engine_config.password.encrypted)).toBe("orig-pass");
  });

  it("re-encrypts when a new password is supplied", async () => {
    const cfg = await makeCfg();
    await createDatabaseConnection(cfg, "rotate", {
      engine: "postgresql",
      engine_config: { host: "db", password: { plaintext: "old" } },
    });
    await updateDatabaseConnection(cfg, "rotate", {
      engine: "postgresql",
      engine_config: { host: "db", password: { plaintext: "new" } },
    });

    const stored = JSON.parse(await fs.readFile(connFile(cfg, "rotate"), "utf8"));
    expect(decryptPassword(stored.engine_config.password.encrypted)).toBe("new");
  });

  it("throws for a missing connection", async () => {
    const cfg = await makeCfg();
    await expect(
      updateDatabaseConnection(cfg, "ghost", { engine: "postgresql", engine_config: {} }),
    ).rejects.toThrow("connection_missing");
  });
});
