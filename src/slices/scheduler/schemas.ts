import { z } from "zod";

const CronScheduleSchema = z.object({
  type: z.literal("cron"),
  expression: z.string().trim().min(1),
  intervalMs: z.undefined().optional(),
});

const IntervalScheduleSchema = z.object({
  type: z.literal("interval"),
  expression: z.undefined().optional(),
  intervalMs: z.number().int().positive(),
});

export const ScheduleSchema = z.discriminatedUnion("type", [
  CronScheduleSchema,
  IntervalScheduleSchema,
]);

export const SchedulerJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule: ScheduleSchema,
  run_once: z.boolean(),
  status: z.enum(["active", "paused", "failed", "completed"]),
  output: z.enum(["ringkas", "detail", "silent"]),
  retry: z.object({
    max_attempts: z.number().int().positive(),
    backoff_ms: z.number().int().nonnegative(),
  }),
  permissions: z.array(z.string()),
  created_by: z.object({
    source: z.string(),
    user_id: z.string(),
  }),
  model: z.string().optional(),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  created_at: z.string(),
});

export type SchedulerJob = z.infer<typeof SchedulerJobSchema>;
