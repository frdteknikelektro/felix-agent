import path from "node:path";
import type { AppConfig } from "../../config.js";
import { readJson, writeJsonAtomic } from "../../lib/fs.js";

/**
 * Simplified checkpoint format: thread_key → ISO timestamp string directly.
 * This reduces the checkpoint file size by ~50% compared to the old format
 * where each entry was an object: { thread_key: { lastIngestAt: "..." } }.
 *
 * The old format is migrated automatically on first load.
 */
export interface Checkpoint {
  threads: Record<string, string>;
  lastLintAt?: string;
}

interface LegacyCheckpointEntry {
  lastIngestAt: string;
}

interface LegacyCheckpoint {
  threads?: Record<string, LegacyCheckpointEntry>;
  lastLintAt?: string;
}

function isLegacyFormat(raw: unknown): raw is LegacyCheckpoint {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (!obj.threads || typeof obj.threads !== "object") return false;
  const threads = obj.threads as Record<string, unknown>;
  const firstKey = Object.keys(threads)[0];
  if (!firstKey) return false;
  const val = threads[firstKey];
  return typeof val === "object" && val !== null && "lastIngestAt" in val;
}

function migrateLegacy(raw: LegacyCheckpoint): Checkpoint {
  const threads: Record<string, string> = {};
  if (raw.threads) {
    for (const [key, entry] of Object.entries(raw.threads)) {
      threads[key] = entry.lastIngestAt;
    }
  }
  return { threads, lastLintAt: raw.lastLintAt };
}

export async function loadCheckpoint(cfg: AppConfig): Promise<Checkpoint> {
  const raw = await readJson<unknown>(path.join(cfg.paths.memoryDir, "checkpoint.json"), {});
  if (isLegacyFormat(raw)) {
    return migrateLegacy(raw);
  }
  const data = raw as Partial<Checkpoint>;
  return {
    threads: data.threads ?? {},
    lastLintAt: data.lastLintAt,
  };
}

export async function saveCheckpoint(cfg: AppConfig, data: Checkpoint): Promise<void> {
  await writeJsonAtomic(path.join(cfg.paths.memoryDir, "checkpoint.json"), {
    threads: data.threads,
    lastLintAt: data.lastLintAt,
  });
}
