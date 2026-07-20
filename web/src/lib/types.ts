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
  harness: HarnessName;
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
  currentProgress?: ProgressEvent;
}

export type HarnessName = "codex" | "opencode" | "claude-code";
export type ProgressPhase = "started" | "thinking" | "tool_started" | "tool_finished" | "waiting_permission" | "completed" | "failed" | "cancelled";
export interface ProgressEvent {
  threadKey: string;
  harness: HarnessName;
  sessionId?: string;
  attempt: number;
  sequence: number;
  at: string;
  phase: ProgressPhase;
  status: string;
  tool?: string;
  elapsedMs?: number;
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

export interface SessionDetail {
  summary: SessionSummary;
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
  harness: HarnessName;
  busy: boolean;
  queueLength: number;
  updatedAt: string;
  lastEventAt?: string;
  lastTurnAt?: string;
  pendingPermissionSkillId?: string;
  currentProgress?: ProgressEvent;
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
  breakdownLimit: number;
  totals: UsageTotals;
  byContact: UsageBreakdownRow[];
  bySource: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byThread: UsageBreakdownRow[];
}

export interface DatabaseConnectionSummary {
  alias: string;
  engine: string;
  created_at: string;
  last_tested: string | null;
  last_tested_ok: boolean | null;
  tags: string[];
  notes: string;
  host: string | null;
  database: string | null;
}

export interface DatabaseConnection {
  alias: string;
  engine: string;
  created_at: string;
  last_tested: string | null;
  last_tested_ok: boolean | null;
  engine_config: Record<string, unknown>;
  ssh: Record<string, unknown> | null;
  timeout_ms: number;
  max_connections: number;
  tags: string[];
  notes: string;
}
