import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

export const SourceSenderSchema = z.object({
  source: z.string(),
  id: z.string(),
  username: z.string().optional(),
  display: z.string().optional(),
});

export const SourceThreadSchema = z.object({
  source: z.string(),
  conversation_id: z.string().optional(),
  thread_id: z.string().optional(),
  root_message_id: z.string().optional(),
  message_id: z.string().optional(),
  team_id: z.string().optional(),
  raw: z.record(z.unknown()).optional(),
});

export const SourceMessageAnchorSchema = z.object({
  source: z.string(),
  conversation_id: z.string().optional(),
  message_id: z.string().optional(),
  thread_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Session domain — thread.json + session.json
// ---------------------------------------------------------------------------

export const ThreadStateSchema = z.object({
  schema_version: z.number().optional(),
  thread_key: z.string(),
  source: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  managed_by_felix: z.boolean(),
  source_thread_ref: SourceThreadSchema,
  participants: z.array(z.string()),
  blocked: z.boolean().optional(),
});

export const SessionQueueItemSchema = z.object({
  received_at: z.string(),
  event_file: z.string(),
  source_event_id: z.string(),
  model_override: z.string().optional(),
});

export const SessionPermissionRequestSchema = z.object({
  request_id: z.string().optional(),
  requested_at: z.string(),
  skill_id: z.string(),
  permissions: z.array(z.string()),
  reason: z.string(),
  owner_message: z.string(),
  owner_message_anchor: SourceMessageAnchorSchema.optional(),
  thread_key: z.string(),
  requester: SourceSenderSchema,
  requester_event_file: z.string(),
});

const SessionUsageCumulativeSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
  total: z.number(),
});

export const SessionStateSchema = z.object({
  schema_version: z.number().optional(),
  harness_session_id: z.string().optional(),
  busy: z.boolean(),
  queue: z.array(SessionQueueItemSchema),
  pending_permission: SessionPermissionRequestSchema.nullable().optional(),
  last_event_at: z.string().optional(),
  last_turn_at: z.string().optional(),
  // Last-seen cumulative token usage for this thread (codex reports session-
  // cumulative usage; we delta against this to record per-turn counts).
  usage_cumulative: SessionUsageCumulativeSchema.nullable().optional(),
  // contact_id of the last human (non-system) event, for attributing usage from
  // synthetic system/proceed turns back to the requester.
  last_event_sender: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Approvals domain — <approvals>/<thread>/<request>.json
// ---------------------------------------------------------------------------

export const ApprovalRecordSchema = z.object({
  schema_version: z.number().optional(),
  id: z.string(),
  requestId: z.string(),
  threadKey: z.string(),
  source: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  requestedAt: z.string(),
  decidedAt: z.string().optional(),
  skillId: z.string(),
  permissions: z.array(z.string()),
  reason: z.string(),
  ownerMessage: z.string(),
  requester: SourceSenderSchema,
  ownerUserId: z.string().optional(),
  ownerMessageAnchor: SourceMessageAnchorSchema.optional(),
  scope: z.enum(["once", "always"]).optional(),
  requestPath: z.string(),
  decisionPath: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tasks domain — tasks/<status>/<task-id>.json
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum([
  "backlog",
  "active",
  "done",
  "cancelled",
  "blocked",
  "paused",
]);

export const TaskRecordSchema = z.object({
  schema_version: z.number().optional(),
  id: z.string(),
  status: TaskStatusSchema,
  title: z.string(),
  description: z.string(),
  created_at: z.string(),
  created_by: z.object({ source: z.string(), user_id: z.string() }),
  parent_source: z.string(),
  parent_thread_key: z.string(),
  parent_post_id: z.string().optional(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  updated_at: z.string(),
});

// ---------------------------------------------------------------------------
// Usage domain — usage/<YYYY-MM-DD>.jsonl (one record per LLM turn)
// ---------------------------------------------------------------------------

export const UsageRecordSchema = z.object({
  schema_version: z.number().optional(),
  at: z.string(),
  source: z.string(),
  contact_id: z.string(),
  thread_key: z.string(),
  harness: z.string(),
  model: z.string().nullable(),
  input: z.number(),
  output: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
  total: z.number(),
});

// ---------------------------------------------------------------------------
// Inferred types — single source of truth for persisted shapes
// ---------------------------------------------------------------------------

export type SourceSender = z.infer<typeof SourceSenderSchema>;
export type SourceThreadRef = z.infer<typeof SourceThreadSchema>;
export type SourceMessageAnchor = z.infer<typeof SourceMessageAnchorSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type SessionQueueItem = z.infer<typeof SessionQueueItemSchema>;
export type SessionPermissionRequest = z.infer<
  typeof SessionPermissionRequestSchema
>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
