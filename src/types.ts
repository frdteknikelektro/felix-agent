// Persisted record types are defined via Zod schemas in core/schemas.ts.
// Re-export them here so existing callers don't need to update imports.
export type {
  SourceMessageAnchor,
  SourceSender,
  SourceThreadRef,
  ThreadState,
  SessionQueueItem,
  SessionPermissionRequest,
  SessionState,
  ApprovalRecord,
  TaskRecord,
  TaskStatus,
  UsageRecord,
} from "./core/schemas.js";

// ---------------------------------------------------------------------------
// Runtime-only types (not persisted to JSON, no Zod schema needed)
// ---------------------------------------------------------------------------

export type SourceName = "mattermost" | string;

export interface UniversalAttachment {
  file_id: string;
  filename: string;
  content_type?: string;
  size_bytes?: number;
  local_path?: string;
  is_image?: boolean;
  status?: "available" | "rejected";
  rejected_reason?: string;
}

export interface UniversalEvent {
  source: SourceName;
  event_id: string;
  thread_key: string;
  received_at: string;
  visibility: "dm" | "channel";
  mentions_bot: boolean;
  sender: import("./core/schemas.js").SourceSender;
  text: string;
  attachments: UniversalAttachment[];
  raw_path: string;
  source_thread_ref: import("./core/schemas.js").SourceThreadRef;
}

export interface SkillRecord {
  id: string;
  name?: string;
  description?: string;
  permissions: string[];
  path: string;
  body: string;
}

export interface ContactRecord {
  source: SourceName;
  user_id: string;
  display?: string;
  username?: string;
  alias?: string;
  allowed_permissions: string[];
  notes?: string;
}

export interface PermissionDecision {
  mode: "once" | "always" | "reject";
}

export type OwnerDecisionTarget =
  | { kind: "thread"; threadKey: string }
  | { kind: "owner_message"; anchor: import("./core/schemas.js").SourceMessageAnchor }
  | { kind: "approval"; approvalId: string };

export interface OwnerDecision {
  mode: "once" | "always" | "reject";
  decidedBy: string;
  target: OwnerDecisionTarget;
}
