import { z } from "zod";

export const ScheduleSchema = z.object({
  type: z.enum(["cron", "interval", "natural"]),
  expression: z.string().optional(),
  intervalMs: z.number().optional(),
  naturalLanguage: z.string().optional(),
  timezone: z.string().optional(),
});

export const RetryConfigSchema = z.object({
  max_attempts: z.number(),
  backoff_ms: z.number(),
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
    conversation_id: z.string(),
    thread_id: z.string(),
    root_message_id: z.string().optional(),
  }),
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
  completed_at: z.string().nullable().default(null),
  status: z.enum(["running", "success", "failed", "retrying"]),
  attempt: z.number().default(1),
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
