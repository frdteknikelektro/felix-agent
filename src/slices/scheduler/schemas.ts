import { z } from "zod";
import { SourceThreadSchema } from "../../core/schemas.js";

const PermissionGrantSchema = z
  .string()
  .trim()
  .min(3)
  .refine(
    (value) => {
      const separator = value.indexOf(":");
      return separator > 0 && separator < value.length - 1;
    },
    {
      message: "permissions must use the namespaced skill:permission format",
    },
  );

const SchedulerOriginSchema = z
  .object({
    source: z.string().trim().min(1),
    thread_key: z.string().trim().min(1),
    source_thread_ref: SourceThreadSchema,
    visibility: z.enum(["dm", "channel"]).default("channel"),
  })
  .superRefine((origin, ctx) => {
    if (origin.source_thread_ref.source !== origin.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_thread_ref", "source"],
        message: "source_thread_ref.source must match origin.source",
      });
    }
    const reference = origin.source_thread_ref;
    const hasStableReference = [
      reference.conversation_id,
      reference.thread_id,
      reference.root_message_id,
      reference.message_id,
      reference.raw,
    ].some((value) => value !== undefined && value !== "");
    if (!hasStableReference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_thread_ref"],
        message: "source_thread_ref must identify a source thread",
      });
    }
  });

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

export const SchedulerJobSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1),
    prompt: z.string(),
    origin: SchedulerOriginSchema,
    schedule: ScheduleSchema,
    run_once: z.boolean(),
    status: z.enum(["active", "paused", "failed", "completed"]),
    output: z.enum(["summary", "detail", "silent"]),
    retry: z.object({
      max_attempts: z.number().int().min(1).max(10),
      backoff_ms: z.number().int().nonnegative().max(86_400_000),
    }),
    permissions: z.array(PermissionGrantSchema),
    created_by: z.object({
      source: z.string().trim().min(1),
      user_id: z.string().trim().min(1),
    }),
    model: z.string().optional(),
    next_run_at: z.string().datetime({ offset: true }).nullable(),
    last_run_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .superRefine((job, ctx) => {
    if (job.status === "active" && job.next_run_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["next_run_at"],
        message: "active jobs require next_run_at",
      });
    }
  });

export type SchedulerJob = z.infer<typeof SchedulerJobSchema>;
