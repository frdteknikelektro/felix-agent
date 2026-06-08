import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { appendText, ensureDir, readText } from "../../lib/fs.js";
import type { AppConfig } from "../../config.js";

export interface AuditEntry {
  id: string;
  at: string;
  actor: "owner";
  source: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  details?: Record<string, unknown>;
}

function auditPath(cfg: AppConfig): string {
  return cfg.paths.audit;
}

export async function recordAuditEntry(
  cfg: AppConfig,
  entry: Omit<AuditEntry, "id"> & { id?: string },
): Promise<AuditEntry> {
  const next: AuditEntry = {
    id: entry.id ?? crypto.randomUUID(),
    at: entry.at,
    actor: entry.actor,
    source: entry.source,
    action: entry.action,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    summary: entry.summary,
    details: entry.details,
  };
  await ensureDir(path.dirname(auditPath(cfg)));
  await appendText(auditPath(cfg), `${JSON.stringify(next)}\n`);
  return next;
}

export async function listAuditEntries(cfg: AppConfig, limit = 200): Promise<AuditEntry[]> {
  const raw = await readText(auditPath(cfg), "");
  const entries: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as AuditEntry);
    } catch {
      // Skip malformed rows.
    }
  }
  return entries.slice(Math.max(0, entries.length - limit)).reverse();
}
