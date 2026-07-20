import { CronExpressionParser } from "cron-parser";
import type { SchedulerJob } from "./schemas.js";

/** Calculate the next occurrence after `after`, always interpreting cron in UTC. */
export function calculateNextRun(
  schedule: SchedulerJob["schedule"],
  after: Date = new Date(),
): string {
  if (schedule.type === "interval") {
    return new Date(after.getTime() + schedule.intervalMs).toISOString();
  }

  const next = CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: "UTC",
  }).next();
  if (!next) throw new Error("cron expression has no future occurrence");
  const iso = next.toISOString();
  if (!iso) throw new Error("cron expression produced no timestamp");
  return iso;
}
