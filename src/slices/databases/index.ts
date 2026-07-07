import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readText, writeTextAtomic } from "../../lib/fs.js";

const DB_ENCRYPTION_KEY = () => process.env.DB_ENCRYPTION_KEY ?? "";

export interface DatabaseConnection {
  alias: string;
  engine: string;
  created_at: string;
  last_tested: string | null;
  last_tested_ok: boolean | null;
  engine_config: Record<string, unknown>;
  ssh: Record<string, unknown> | null;
  timeout_ms: number;
  max_connections: number;
  tags: string[];
  notes: string;
}

export type DatabaseConnectionSummary = Pick<
  DatabaseConnection,
  "alias" | "engine" | "created_at" | "last_tested" | "last_tested_ok" | "tags" | "notes"
> & {
  host: string | null;
  database: string | null;
};

export class DatabaseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function connectionsDir(cfg: AppConfig): string {
  return path.join(cfg.paths.root, "databases", "connections");
}

function connectionPath(cfg: AppConfig, alias: string): string {
  return path.join(connectionsDir(cfg), `${alias}.json`);
}

export function validateAlias(alias: string): string | null {
  if (!alias || !/^[A-Za-z0-9._-]+$/.test(alias)) return null;
  return alias;
}

export async function listConnections(cfg: AppConfig): Promise<DatabaseConnectionSummary[]> {
  const dir = connectionsDir(cfg);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const connections: DatabaseConnectionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), "utf8");
      const conn: DatabaseConnection = JSON.parse(raw);
      connections.push(summarize(conn));
    } catch {
      // skip malformed files
    }
  }
  return connections.sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function loadConnection(cfg: AppConfig, alias: string): Promise<DatabaseConnection | null> {
  const file = connectionPath(cfg, alias);
  if (!(await pathExists(file))) return null;
  const raw = await readText(file, "");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveConnection(cfg: AppConfig, alias: string, conn: DatabaseConnection): Promise<DatabaseConnection> {
  await ensureDir(connectionsDir(cfg));
  const file = connectionPath(cfg, alias);
  await writeTextAtomic(file, JSON.stringify(conn, null, 2));
  return conn;
}

export async function deleteConnection(cfg: AppConfig, alias: string): Promise<void> {
  const file = connectionPath(cfg, alias);
  if (!(await pathExists(file))) {
    throw new DatabaseError("not_found", `Connection '${alias}' not found`);
  }
  await fs.unlink(file);
}

export function encryptPassword(plaintext: string): string {
  const key = Buffer.from(DB_ENCRYPTION_KEY(), "base64");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted}`;
}

export function decryptPassword(encryptedStr: string): string {
  const key = Buffer.from(DB_ENCRYPTION_KEY(), "base64");
  const parts = encryptedStr.split(":");
  if (parts.length !== 3) {
    throw new DatabaseError("bad_ciphertext", "Encrypted value must be 'iv:tag:ciphertext'");
  }
  const [ivB64, tagB64, encrypted] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Encrypt secrets in an engine_config before persisting. The UI sends a password as
 * `{ plaintext }`; this replaces it with `{ encrypted }`. When the incoming password is
 * absent (edit form left blank → "keep existing"), the existing encrypted value is carried
 * forward so editing other fields never wipes the stored credential.
 */
export function encryptEngineConfigSecrets(
  engineConfig: Record<string, unknown>,
  existing?: Record<string, unknown> | null,
): Record<string, unknown> {
  const out = { ...engineConfig };
  const incoming = out["password"] as { plaintext?: unknown; encrypted?: unknown } | null | undefined;
  const plaintext = incoming && typeof incoming === "object" ? incoming.plaintext : undefined;

  if (typeof plaintext === "string" && plaintext.length > 0) {
    out["password"] = { encrypted: encryptPassword(plaintext) };
  } else if (incoming && typeof incoming === "object" && typeof incoming.encrypted === "string") {
    // already encrypted — leave as-is
    out["password"] = { encrypted: incoming.encrypted };
  } else {
    // no usable incoming password → preserve existing encrypted credential if present
    const prev = existing?.["password"] as { encrypted?: unknown } | null | undefined;
    if (prev && typeof prev === "object" && typeof prev.encrypted === "string") {
      out["password"] = { encrypted: prev.encrypted };
    } else {
      delete out["password"];
    }
  }
  return out;
}

export function normalizeConnectionInput(input: Record<string, unknown>): {
  engine: string;
  engine_config: Record<string, unknown>;
  ssh: Record<string, unknown> | null;
  timeout_ms: number;
  max_connections: number;
  tags: string[];
  notes: string;
} {
  const engine = typeof input["engine"] === "string" ? input["engine"] : "";
  const engine_config = (typeof input["engine_config"] === "object" && input["engine_config"] !== null
    ? input["engine_config"]
    : {}) as Record<string, unknown>;
  const ssh = (typeof input["ssh"] === "object" && input["ssh"] !== null
    ? input["ssh"]
    : null) as Record<string, unknown> | null;
  const timeout_ms = typeof input["timeout_ms"] === "number" ? input["timeout_ms"] : 10000;
  const max_connections = typeof input["max_connections"] === "number" ? input["max_connections"] : 5;
  const tags = Array.isArray(input["tags"])
    ? input["tags"].map((t) => String(t).trim()).filter(Boolean)
    : [];
  const notes = typeof input["notes"] === "string" ? input["notes"] : "";

  return { engine, engine_config, ssh, timeout_ms, max_connections, tags, notes };
}

function summarize(conn: DatabaseConnection): DatabaseConnectionSummary {
  const ec = conn.engine_config ?? {};
  return {
    alias: conn.alias,
    engine: conn.engine,
    created_at: conn.created_at,
    last_tested: conn.last_tested,
    last_tested_ok: conn.last_tested_ok,
    tags: conn.tags,
    notes: conn.notes,
    host: (ec["host"] as string) ?? (ec["path"] as string) ?? (ec["account_endpoint"] as string) ?? null,
    database: (ec["database"] as string) ?? (ec["path"] as string) ?? null,
  };
}
