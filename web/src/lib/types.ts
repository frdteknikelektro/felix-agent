// Mirrors the server shapes in src/owner-data.ts, src/core/schemas.ts and
// src/slices/*. Kept in sync by hand — the API is small and stable.

export interface SourceSender {
  source: string;
  id: string;
  username?: string;
  display?: string;
}

export interface SessionSummary {
  threadKey: string;
  source: string;
  harness: "Codex";
  createdAt: string;
  updatedAt: string;
  managedByFelix: boolean;
  busy: boolean;
  queueLength: number;
  harnessSessionId?: string;
  lastEventAt?: string;
  lastTurnAt?: string;
  pendingPermissionId?: string;
  pendingPermissionSkillId?: string;
}

export interface SessionHistoryItem {
  at: string;
  kind: string;
  title: string;
  path: string;
  summary: string;
}

export interface SessionArtifact {
  path: string;
  label: string;
  kind: "json" | "markdown" | "text";
  content: string;
  truncated: boolean;
}

export interface SourceThreadRef {
  source: string;
  conversation_id?: string;
  thread_id?: string;
  root_message_id?: string;
  message_id?: string;
  team_id?: string;
}

export interface ThreadState {
  thread_key: string;
  source: string;
  created_at: string;
  updated_at: string;
  managed_by_felix: boolean;
  source_thread_ref: SourceThreadRef;
  participants: string[];
}

export interface SessionState {
  harness_session_id?: string;
  busy: boolean;
  queue: { received_at: string; event_file: string; source_event_id: string }[];
  pending_permission?: unknown;
  last_event_at?: string;
  last_turn_at?: string;
}

export interface SessionDetail {
  summary: SessionSummary;
  thread: ThreadState;
  session: SessionState;
  history: SessionHistoryItem[];
  artifacts: SessionArtifact[];
}

export type ChatDirection = "inbound" | "outbound" | "system";

export interface ChatMessage {
  id: string;
  at: string;
  kind: "source_event" | "felix_reply" | "owner_permission" | "permission_request" | "unknown";
  direction: ChatDirection;
  sender: SourceSender;
  text: string;
}

export interface ApprovalRecord {
  id: string;
  requestId: string;
  threadKey: string;
  source: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedAt?: string;
  skillId: string;
  permissions: string[];
  reason: string;
  ownerMessage: string;
  requester: SourceSender;
  ownerUserId?: string;
  scope?: "once" | "always";
  requestPath: string;
  decisionPath?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  source: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  details?: Record<string, unknown>;
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
  source: string;
  user_id: string;
  display?: string;
  username?: string;
  alias?: string;
  allowed_permissions: string[];
  notes?: string;
}

export interface DashboardActivityItem {
  at: string;
  kind: "audit" | "turn" | "message";
  summary: string;
  threadKey?: string;
  source?: string;
}

export interface DashboardActiveSession {
  threadKey: string;
  source: string;
  busy: boolean;
  queueLength: number;
  updatedAt: string;
  lastEventAt?: string;
  lastTurnAt?: string;
  pendingPermissionSkillId?: string;
}

export interface DashboardSnapshot {
  at: string;
  activeSessions: number;
  totalQueueDepth: number;
  pendingApprovals: number;
  sessionsToday: number;
  activeSessionList: DashboardActiveSession[];
  pendingApprovalList: ApprovalRecord[];
  recentActivity: DashboardActivityItem[];
  tokensToday: number;
}

export type UsageWindow = "today" | "week" | "month" | "all";

export interface UsageTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
  turns: number;
}

export interface UsageBreakdownRow extends UsageTotals {
  key: string;
}

export interface UsageView {
  window: UsageWindow;
  tz: string;
  generatedAt: string;
  totals: UsageTotals;
  byContact: UsageBreakdownRow[];
  bySource: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byThread: UsageBreakdownRow[];
}
