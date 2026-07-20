import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { readText, writeTextAtomic, ensureDir, pathExists } from "./lib/fs.js";
import { renderFrontmatter } from "./lib/markdown.js";
import { eventAt, historyTitle, parseEventFile, type ParsedEvent } from "./slices/events/index.js";
import type { AuditEntry } from "./slices/audit/index.js";
import { listAuditEntries, recordAuditEntry } from "./slices/audit/index.js";
import type { SessionState, SkillRecord, SourceSender } from "./types.js";
import { findThreadHandle, listThreadHandles, loadSessionState, type ThreadHandle } from "./slices/sessions/index.js";
import { loadSkills } from "./slices/skills/index.js";
import type { ApprovalRecord } from "./slices/approvals/index.js";
import { listApprovalRecords } from "./slices/approvals/index.js";
import { progressStore, type HarnessName, type ProgressEvent } from "./slices/progress/index.js";
import { tokensToday } from "./slices/usage/index.js";
import { tzDateKey } from "./lib/time.js";
import {
  listConnections,
  loadConnection,
  saveConnection,
  deleteConnection,
  normalizeConnectionInput,
  encryptEngineConfigSecrets,
  type DatabaseConnection,
  type DatabaseConnectionSummary,
} from "./slices/databases/index.js";

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

/** A single rendered message in the chat-style thread view. */
export interface ChatMessage {
  id: string;
  at: string;
  kind: ParsedEvent["kind"];
  /** inbound = from a source user, outbound = from Felix, system = permission notices. */
  direction: "inbound" | "outbound" | "system";
  sender: SourceSender;
  text: string;
}

/** One row in the dashboard live activity feed. */
export interface DashboardActivityItem {
  at: string;
  kind: "audit" | "turn" | "message";
  summary: string;
  threadKey?: string;
  source?: string;
}

/** A compact session entry for the dashboard active-sessions panel. */
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

/** The full snapshot pushed to dashboard clients over SSE. */
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

const ACTIVE_SESSION_LIMIT = 15;
const RECENT_ACTIVITY_LIMIT = 40;

export async function listSessionSummaries(cfg: AppConfig): Promise<SessionSummary[]> {
  const threads = await listThreadHandles(cfg);
  const summaries = await Promise.all(threads.map(async (thread) => buildSessionSummary(thread, undefined, cfg.HARNESS)));
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadSessionDetail(cfg: AppConfig, threadKey: string): Promise<SessionDetail | null> {
  const thread = await findThreadHandle(cfg, threadKey);
  if (!thread) return null;
  const session = await loadSessionState(thread);
  const summary = await buildSessionSummary(thread, session, cfg.HARNESS);
  const history = await loadSessionHistory(thread);
  const artifacts = await loadSessionArtifacts(thread);
  return {
    summary,
    history,
    artifacts,
  };
}

/**
 * Load a thread's full message history as chat bubbles — full body text (not the
 * 220-char summary used by {@link loadSessionDetail}), ordered chronologically.
 * Returns null when the thread does not exist.
 */
export async function loadChatTimeline(cfg: AppConfig, threadKey: string): Promise<ChatMessage[] | null> {
  const thread = await findThreadHandle(cfg, threadKey);
  if (!thread) return null;
  const entries = await fs.readdir(thread.eventsDir, { withFileTypes: true }).catch(() => []);
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = await readText(path.join(thread.eventsDir, entry.name), "");
    const parsed = parseEventFile(raw);
    const at = eventAt(parsed) ?? fsDateFromName(entry.name);
    messages.push(chatMessageFromEvent(parsed, at, entry.name, thread.state.source, cfg.FELIX_NAME));
  }
  return messages.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Map a parsed event file to a chat bubble. Pure — no IO — so it is unit-tested
 * directly. `source` is the thread's source, used for Felix's own bubbles.
 */
export function chatMessageFromEvent(
  parsed: ParsedEvent,
  at: string,
  fallbackId: string,
  source: string,
  agentName = "Felix",
): ChatMessage {
  switch (parsed.kind) {
    case "source_event":
      return {
        id: parsed.frontmatter.event_id ?? fallbackId,
        at,
        kind: parsed.kind,
        direction: "inbound",
        sender: parsed.frontmatter.sender ?? { source, id: "unknown" },
        text: parsed.body.trim(),
      };
    case "felix_reply":
      return {
        id: `felix_${at}`,
        at,
        kind: parsed.kind,
        direction: "outbound",
        sender: { source, id: "felix", display: agentName },
        text: parsed.body.trim(),
      };
    case "permission_request":
      return {
        id: parsed.frontmatter.request_id ?? `req_${at}`,
        at,
        kind: parsed.kind,
        direction: "system",
        sender: { source, id: "felix", display: agentName },
        text: parsed.body.trim(),
      };
    case "owner_permission":
      return {
        id: parsed.frontmatter.request_id ?? `owner_${at}`,
        at,
        kind: parsed.kind,
        direction: "system",
        sender: { source: "owner", id: parsed.frontmatter.owner_user_id ?? "owner", display: "Owner" },
        text: parsed.body.trim(),
      };
    case "unknown":
      return {
        id: `evt_${at}`,
        at,
        kind: parsed.kind,
        direction: "system",
        sender: { source: "system", id: "system" },
        text: parsed.body.trim(),
      };
  }
}

/**
 * Build the live dashboard snapshot. Reads session summaries, approvals and the
 * audit log, then delegates to the pure {@link buildDashboardSnapshot}.
 */
export async function dashboardSnapshot(cfg: AppConfig): Promise<DashboardSnapshot> {
  const now = new Date();
  const [summaries, approvals, audit, todayTokens] = await Promise.all([
    listSessionSummaries(cfg),
    listApprovalRecords(cfg),
    listAuditForUi(cfg),
    tokensToday(cfg, now),
  ]);
  return buildDashboardSnapshot(summaries, approvals, audit, now, todayTokens, cfg.USAGE_TZ, cfg.FELIX_NAME);
}

/**
 * Pure dashboard-snapshot builder — no IO, so it is unit-tested directly.
 * `recentActivity` merges owner audit entries with per-session turn/message
 * activity derived from the summaries we already loaded (no extra disk reads).
 */
export function buildDashboardSnapshot(
  summaries: SessionSummary[],
  approvals: ApprovalRecord[],
  audit: AuditEntry[],
  now: Date,
  tokensToday = 0,
  tz = "UTC",
  agentName = "Felix",
): DashboardSnapshot {
  const pending = approvals.filter((a) => a.status === "pending");
  const today = tzDateKey(now, tz);

  const activeSessionList = [...summaries]
    .sort((a, b) => Number(b.busy) - Number(a.busy) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, ACTIVE_SESSION_LIMIT)
    .map((s) => ({
      threadKey: s.threadKey,
      source: s.source,
      harness: s.harness,
      busy: s.busy,
      queueLength: s.queueLength,
      updatedAt: s.updatedAt,
      lastEventAt: s.lastEventAt,
      lastTurnAt: s.lastTurnAt,
      pendingPermissionSkillId: s.pendingPermissionSkillId,
      currentProgress: s.currentProgress,
    }));

  const activity: DashboardActivityItem[] = [];
  for (const entry of audit) {
    activity.push({ at: entry.at, kind: "audit", summary: entry.summary });
  }
  for (const s of summaries) {
    if (s.lastTurnAt) {
      activity.push({ at: s.lastTurnAt, kind: "turn", summary: `${agentName} replied in ${s.source}`, threadKey: s.threadKey, source: s.source });
    }
    if (s.lastEventAt && s.lastEventAt !== s.lastTurnAt) {
      activity.push({ at: s.lastEventAt, kind: "message", summary: `New message in ${s.source}`, threadKey: s.threadKey, source: s.source });
    }
  }
  const recentActivity = activity
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, RECENT_ACTIVITY_LIMIT);

  return {
    at: now.toISOString(),
    activeSessions: summaries.filter((s) => s.busy).length,
    totalQueueDepth: summaries.reduce((sum, s) => sum + s.queueLength, 0),
    pendingApprovals: pending.length,
    sessionsToday: summaries.filter((s) => tzDateKey(s.createdAt, tz) === today).length,
    activeSessionList,
    pendingApprovalList: pending,
    recentActivity,
    tokensToday,
  };
}

export async function listSkillsForUi(cfg: AppConfig): Promise<SkillRecord[]> {
  return loadSkills(cfg);
}

export async function loadSkillForUi(cfg: AppConfig, skillId: string): Promise<SkillRecord | null> {
  const skills = await loadSkills(cfg);
  return skills.find((skill) => skill.id === skillId) ?? null;
}

export async function saveSkillForUi(
  cfg: AppConfig,
  skillId: string,
  input: Pick<SkillRecord, "name" | "description" | "permissions" | "body">,
): Promise<SkillRecord> {
  const dir = path.join(cfg.paths.skills, skillId);
  const file = path.join(dir, "SKILL.md");
  await ensureDir(dir);
  const frontmatter = renderSkillFrontmatter(skillId, input);
  await writeTextAtomic(file, renderFrontmatter(frontmatter, input.body));
  const skill = {
    id: skillId,
    name: input.name,
    description: input.description,
    permissions: normalizePermissions(input.permissions),
    path: file,
    body: input.body,
  };
  return skill;
}

export async function deleteSkillForUi(cfg: AppConfig, skillId: string): Promise<void> {
  const dir = path.join(cfg.paths.skills, skillId);
  if (!(await pathExists(dir))) {
    throw new Error("skill_missing");
  }
  await fs.rm(dir, { recursive: true, force: true });
}

export async function listAuditForUi(cfg: AppConfig): Promise<AuditEntry[]> {
  return listAuditEntries(cfg);
}

export async function addSkillAudit(
  cfg: AppConfig,
  skillId: string,
  action: string,
  summary: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await recordAuditEntry(cfg, {
    at: new Date().toISOString(),
    actor: "owner",
    source: "ui",
    action,
    entity_type: "skill",
    entity_id: skillId,
    summary,
    details,
  });
}

export async function addContactAudit(
  cfg: AppConfig,
  source: string,
  userId: string,
  action: string,
  summary: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await recordAuditEntry(cfg, {
    at: new Date().toISOString(),
    actor: "owner",
    source: "ui",
    action,
    entity_type: "contact",
    entity_id: `${source}:${userId}`,
    summary,
    details,
  });
}

export async function addApprovalAudit(
  cfg: AppConfig,
  approval: ApprovalRecord,
  action: "approve" | "reject",
  ownerUserId: string,
): Promise<void> {
  await recordAuditEntry(cfg, {
    at: new Date().toISOString(),
    actor: "owner",
    source: "ui",
    action,
    entity_type: "approval",
    entity_id: approval.id,
    summary: `${action === "approve" ? "Approved" : "Rejected"} ${approval.skillId} for ${approval.requester.display ?? approval.requester.id}`,
    details: {
      threadKey: approval.threadKey,
      requesterId: approval.requester.id,
      ownerUserId,
      scope: approval.scope ?? "once",
      permissions: approval.permissions,
    },
  });
}

async function buildSessionSummary(thread: ThreadHandle, session?: SessionState, harness: HarnessName = "codex"): Promise<SessionSummary> {
  const current = session ?? (await loadSessionState(thread));
  return {
    threadKey: thread.state.thread_key,
    source: thread.state.source,
    harness,
    createdAt: thread.state.created_at,
    updatedAt: thread.state.updated_at,
    managedByFelix: thread.state.managed_by_felix,
    busy: current.busy,
    queueLength: current.queue.length,
    harnessSessionId: current.harness_session_id,
    lastEventAt: current.last_event_at,
    lastTurnAt: current.last_turn_at,
    pendingPermissionId: current.pending_permission ? approvalIdForPending(thread, current.pending_permission) : undefined,
    pendingPermissionSkillId: current.pending_permission?.skill_id,
    currentProgress: progressStore.current(thread.state.thread_key),
  };
}

async function loadSessionHistory(thread: ThreadHandle): Promise<SessionHistoryItem[]> {
  const entries = await fs.readdir(thread.eventsDir, { withFileTypes: true }).catch(() => []);
  const out: SessionHistoryItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(thread.eventsDir, entry.name);
    const raw = await readText(file, "");
    const parsed = parseEventFile(raw);
    const kind = parsed.kind === "unknown" ? "artifact" : parsed.kind;
    const at = eventAt(parsed) ?? fsDateFromName(entry.name);
    const title = historyTitle(parsed, raw);
    const body = parsed.body.trim();
    const summary = body ? truncate(body.replace(/\s+/g, " "), 220) : "(no body)";
    out.push({
      at,
      kind,
      title,
      path: path.relative(thread.dir, file),
      summary,
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

async function loadSessionArtifacts(thread: ThreadHandle): Promise<SessionArtifact[]> {
  const artifacts: SessionArtifact[] = [];
  const pushArtifact = async (file: string, label?: string, kind: SessionArtifact["kind"] = "text") => {
    const raw = await readText(file, "");
    artifacts.push({
      path: path.relative(thread.dir, file),
      label: label ?? path.basename(file),
      kind,
      content: raw,
      truncated: false,
    });
  };

  await pushArtifact(thread.threadFile, "thread.json", "json");
  await pushArtifact(thread.sessionFile, "session.json", "json");
  await pushArtifact(thread.transcriptFile, "transcript.md", "markdown");

  const eventEntries = await fs.readdir(thread.eventsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of eventEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    await pushArtifact(path.join(thread.eventsDir, entry.name), path.join("events", entry.name), "markdown");
  }

  const turnEntries = await fs.readdir(thread.turnsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of turnEntries) {
    if (!entry.isFile()) continue;
    const file = path.join(thread.turnsDir, entry.name);
    const raw = await readText(file, "");
    const truncated = raw.length > 50_000;
    artifacts.push({
      path: path.relative(thread.dir, file),
      label: path.join("turns", entry.name),
      kind: entry.name.endsWith(".md") ? "markdown" : "text",
      content: truncated ? `${raw.slice(0, 50_000)}\n\n... truncated ...` : raw,
      truncated,
    });
  }

  return artifacts;
}

function renderSkillFrontmatter(skillId: string, input: Pick<SkillRecord, "name" | "description" | "permissions">): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    name: skillId,
    description: input.description,
  };
  const perms = normalizePermissions(input.permissions);
  if (perms.length > 0) {
    fm.metadata = { permissions: perms.join(", ") };
  }
  return fm;
}

function approvalIdForPending(thread: ThreadHandle, pending: NonNullable<SessionState["pending_permission"]>): string {
  return pending.request_id ?? approvalIdFromPath(pending.requester_event_file) ?? `${thread.state.thread_key}:${pending.requested_at}`;
}

function approvalIdFromPath(file: string): string {
  const base = path.basename(file);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function normalizePermissions(value: string[]): string[] {
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function fsDateFromName(name: string): string {
  return name.replace(/\.md$/, "");
}

// ---------------------------------------------------------------------------
// Database connections
// ---------------------------------------------------------------------------

export async function listDatabaseConnections(cfg: AppConfig): Promise<DatabaseConnectionSummary[]> {
  return listConnections(cfg);
}

export async function loadDatabaseConnection(cfg: AppConfig, alias: string): Promise<DatabaseConnection | null> {
  return loadConnection(cfg, alias);
}

export async function createDatabaseConnection(
  cfg: AppConfig,
  alias: string,
  input: Record<string, unknown>,
): Promise<DatabaseConnection> {
  const existing = await loadConnection(cfg, alias);
  if (existing) {
    throw new Error("connection_exists");
  }
  const normalized = normalizeConnectionInput(input);
  const conn: DatabaseConnection = {
    alias,
    engine: normalized.engine,
    created_at: new Date().toISOString(),
    last_tested: null,
    last_tested_ok: null,
    engine_config: encryptEngineConfigSecrets(normalized.engine_config),
    ssh: normalized.ssh,
    timeout_ms: normalized.timeout_ms,
    max_connections: normalized.max_connections,
    tags: normalized.tags,
    notes: normalized.notes,
  };
  return saveConnection(cfg, alias, conn);
}

export async function updateDatabaseConnection(
  cfg: AppConfig,
  alias: string,
  input: Record<string, unknown>,
): Promise<DatabaseConnection> {
  const existing = await loadConnection(cfg, alias);
  if (!existing) {
    throw new Error("connection_missing");
  }
  const normalized = normalizeConnectionInput(input);
  const conn: DatabaseConnection = {
    ...existing,
    engine: normalized.engine || existing.engine,
    engine_config: encryptEngineConfigSecrets(normalized.engine_config, existing.engine_config),
    ssh: normalized.ssh,
    timeout_ms: normalized.timeout_ms,
    max_connections: normalized.max_connections,
    tags: normalized.tags,
    notes: normalized.notes,
  };
  return saveConnection(cfg, alias, conn);
}

export async function deleteDatabaseConnection(cfg: AppConfig, alias: string): Promise<void> {
  return deleteConnection(cfg, alias);
}

export async function addDatabaseAudit(
  cfg: AppConfig,
  alias: string,
  action: string,
  summary: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await recordAuditEntry(cfg, {
    at: new Date().toISOString(),
    actor: "owner",
    source: "ui",
    action,
    entity_type: "database",
    entity_id: alias,
    summary,
    details,
  });
}
