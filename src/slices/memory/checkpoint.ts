import path from "node:path";
import type { AppConfig } from "../../config.js";
import { readJson, writeJsonAtomic } from "../../lib/fs.js";

/**
 * Simplified checkpoint format: thread_key → ISO timestamp string directly.
 * This reduces the checkpoint file size by ~50% compared to the old format
 * where each entry was an object: { thread_key: { lastIngestAt: "..." } }.
 */
export interface Checkpoint {
  threads: Record<string, string>;
  lastLintAt?: string;
}

export async function loadCheckpoint(cfg: AppConfig): Promise<Checkpoint> {
  const raw = await readJson<Partial<Checkpoint>>(path.join(cfg.paths.memoryDir, "checkpoint.json"), {});
  return {
    threads: raw.threads ?? {},
    lastLintAt: raw.lastLintAt,
  };
}

export async function saveCheckpoint(cfg: AppConfig, data: Checkpoint): Promise<void> {
  await writeJsonAtomic(path.join(cfg.paths.memoryDir, "checkpoint.json"), {
    threads: data.threads,
    lastLintAt: data.lastLintAt,
  });
}
