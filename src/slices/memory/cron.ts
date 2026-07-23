import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { log } from "../../lib/log.js";

interface CronState {
  locked: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const state: CronState = { locked: false, timer: null };

const LOG_RETENTION_DAYS = 7;

function parseCronExpression(expr: string): { minute: number; hour: number } {
  const parts = expr.split(" ");
  if (parts.length < 2) return { minute: 0, hour: 3 };
  const minute = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);
  return {
    minute: isNaN(minute) ? 0 : minute,
    hour: isNaN(hour) ? 3 : hour,
  };
}

function nextScheduleMs(cronExpr: string): number {
  const { minute, hour } = parseCronExpression(cronExpr);
  const now = Date.now();
  const target = new Date();
  target.setUTCHours(hour, minute, 0, 0);

  if (target.getTime() <= now) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now;
}

function scheduleNext(cfg: AppConfig): void {
  const cronExpr = cfg.MEMORY_CLEANUP_CRON || "0 3 * * *";
  const delay = nextScheduleMs(cronExpr);
  log.info("memory: next cleanup scheduled", {
    at: new Date(Date.now() + delay).toISOString(),
    cron: cronExpr,
  });

  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.locked) return scheduleNext(cfg);
    state.locked = true;
    runCleanup(cfg)
      .catch((err) => {
        log.error("memory: cleanup failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        state.locked = false;
        scheduleNext(cfg);
      });
  }, delay);

  state.timer.unref();
}

export function startMemoryCron(cfg: AppConfig): void {
  if (state.timer) return;
  scheduleNext(cfg);
}

export function stopMemoryCron(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

async function runCleanup(cfg: AppConfig): Promise<void> {
  const logsDir = cfg.paths.memoryLogsDir;
  log.info("memory: starting log cleanup", { dir: logsDir });

  try {
    const entries = await fs.readdir(logsDir).catch(() => []);
    const now = Date.now();
    const cutoffMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const dateStr = entry.replace(".md", "");
      const entryDate = new Date(dateStr);

      if (isNaN(entryDate.getTime())) {
        log.warn("memory: skipping invalid log filename", { file: entry });
        continue;
      }

      const ageMs = now - entryDate.getTime();
      if (ageMs > cutoffMs) {
        const filePath = path.join(logsDir, entry);
        try {
          await fs.unlink(filePath);
          deletedCount++;
          log.info("memory: deleted old log", { file: entry, ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)) });
        } catch (err) {
          log.error("memory: failed to delete log", {
            file: entry,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    log.info("memory: cleanup complete", { deleted: deletedCount, remaining: entries.length - deletedCount });

    if (deletedCount > 0) {
      await appendCleanupLog(cfg, deletedCount);
    }
  } catch (err) {
    log.error("memory: cleanup error", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function appendCleanupLog(cfg: AppConfig, deletedCount: number): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const logPath = path.join(cfg.paths.memoryLogsDir, `${today}.md`);

  const entry = `- [${new Date().toISOString()}] Memory cleanup: deleted ${deletedCount} log(s) older than ${LOG_RETENTION_DAYS} days\n`;

  try {
    await fs.appendFile(logPath, entry, "utf-8");
  } catch {
    log.warn("memory: failed to append cleanup log");
  }
}
