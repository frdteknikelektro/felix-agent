import { z } from "zod";

export const ScheduleSchema = z.object({
  type: z.enum(["cron", "interval", "natural"]),
  expression: z.string().trim().min(1).optional(),
  intervalMs: z.number().int().positive().optional(),
  naturalLanguage: z.string().optional(),
  timezone: z.string().trim().min(1).optional(),
});

export const RetryConfigSchema = z.object({
  max_attempts: z.number().int().positive(),
  backoff_ms: z.number().int().nonnegative(),
});

export const SchedulerJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule: ScheduleSchema,
  run_once: z.boolean(),
  created_by: z.object({
    source: z.string(),
    user_id: z.string(),
  }),
  source_thread_ref: z.object({
    source: z.string(),
    conversation_id: z.string().optional(),
    thread_id: z.string().optional(),
    root_message_id: z.string().optional(),
    message_id: z.string().optional(),
    team_id: z.string().optional(),
    raw: z.record(z.unknown()).optional(),
  }),
  source_thread_key: z.string(),
  permissions: z.array(z.string()),
  output: z.enum(["ringkas", "detail", "silent"]),
  retry: RetryConfigSchema,
  status: z.enum(["active", "paused", "failed", "completed"]),
  last_run_at: z.string().nullable(),
  next_run_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const SchedulerExecutionSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  status: z.enum(["running", "success", "failed", "retrying"]),
  attempt: z.number(),
  result: z
    .object({
      success: z.boolean(),
      output: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  session_id: z.string().optional(),
});

export type Schedule = z.infer<typeof ScheduleSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type SchedulerJob = z.infer<typeof SchedulerJobSchema>;
export type SchedulerExecution = z.infer<typeof SchedulerExecutionSchema>;
