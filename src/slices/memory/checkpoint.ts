import path from "node:path";
import type { AppConfig } from "../../config.js";
import { readJson, writeJsonAtomic } from "../../lib/fs.js";

/**
 * Minimal checkpoint: just two timestamps.
 * - lastIngestedAt: when the last successful ingestion run completed
 * - lastLintAt: when the last wiki lint run completed
 */
export interface Checkpoint {
  lastIngestedAt?: string;
  lastLintAt?: string;
}

export async function loadCheckpoint(cfg: AppConfig): Promise<Checkpoint> {
  return readJson<Checkpoint>(path.join(cfg.paths.memoryDir, "checkpoint.json"), {});
}

export async function saveCheckpoint(cfg: AppConfig, data: Checkpoint): Promise<void> {
  await writeJsonAtomic(path.join(cfg.paths.memoryDir, "checkpoint.json"), {
    lastIngestedAt: data.lastIngestedAt,
    lastLintAt: data.lastLintAt,
  });
}
