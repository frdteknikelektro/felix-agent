import { z } from "zod";

export const SchedulerJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule: z.object({
    type: z.enum(["cron", "interval"]),
    expression: z.string().optional(),
    intervalMs: z.number().optional(),
  }),
  run_once: z.boolean(),
  status: z.enum(["active", "paused", "failed", "completed"]),
  output: z.enum(["ringkas", "detail", "silent"]),
  retry: z.object({
    max_attempts: z.number(),
    backoff_ms: z.number(),
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
