import { CronExpressionParser } from "cron-parser";
import type { AppConfig } from "../../config.js";
import type { Harness } from "../../core/ports.js";
import { log } from "../../lib/log.js";
import { runMemoryMaintenance } from "./maintenance.js";

interface CronState {
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const state: CronState = { running: false, timer: null };

export function nextMemoryMaintenanceAt(cfg: AppConfig, now = new Date()): Date {
  return CronExpressionParser.parse(cfg.MEMORY_MAINTENANCE_CRON, {
    currentDate: now,
    tz: cfg.OWNER_TZ,
  }).next().toDate();
}

function scheduleNext(cfg: AppConfig, harness: Harness): void {
  const next = nextMemoryMaintenanceAt(cfg);
  const delay = Math.max(0, next.getTime() - Date.now());
  log.info("memory: next maintenance scheduled", {
    at: next.toISOString(),
    cron: cfg.MEMORY_MAINTENANCE_CRON,
    timezone: cfg.OWNER_TZ,
  });
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.running) {
      scheduleNext(cfg, harness);
      return;
    }
    state.running = true;
    runMemoryMaintenance(cfg, harness)
      .catch((error) => log.error("memory: maintenance failed", {
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        state.running = false;
        scheduleNext(cfg, harness);
      });
  }, delay);
  state.timer.unref();
}

export function startMemoryCron(cfg: AppConfig, harness: Harness): void {
  if (!state.timer) scheduleNext(cfg, harness);
}

export function stopMemoryCron(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}
