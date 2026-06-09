import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { loadContact, saveContact, contactPath } from "./slices/contacts/index.js";
import { readText, writeTextAtomic, ensureDir, pathExists } from "./lib/fs.js";
import { renderFrontmatter } from "./lib/markdown.js";
import { eventAt, historyTitle, parseEventFile } from "./slices/events/index.js";
import type { AuditEntry } from "./slices/audit/index.js";
import { listAuditEntries, recordAuditEntry } from "./slices/audit/index.js";
import type { ContactRecord, SessionState, SkillRecord, ThreadState } from "./types.js";
import { findThreadHandle, listThreadHandles, loadSessionState, loadThreadState, type ThreadHandle } from "./slices/sessions/index.js";
import { loadSkills, writeSkillIndex } from "./slices/skills/index.js";
import type { ApprovalRecord } from "./slices/approvals/index.js";

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

export interface SessionDetail {
  summary: SessionSummary;
  thread: ThreadState;
  session: SessionState;
  history: SessionHistoryItem[];
  artifacts: SessionArtifact[];
}

export async function listSessionSummaries(cfg: AppConfig): Promise<SessionSummary[]> {
  const threads = await listThreadHandles(cfg);
  const summaries = await Promise.all(threads.map(async (thread) => buildSessionSummary(thread)));
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadSessionDetail(cfg: AppConfig, threadKey: string): Promise<SessionDetail | null> {
  const thread = await findThreadHandle(cfg, threadKey);
  if (!thread) return null;
  const session = await loadSessionState(thread);
  const summary = await buildSessionSummary(thread, session);
  const history = await loadSessionHistory(thread);
  const artifacts = await loadSessionArtifacts(thread);
  return {
    summary,
    thread: await loadThreadState(thread),
    session,
    history,
    artifacts,
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
  await writeSkillIndex(cfg, await loadSkills(cfg));
  return skill;
}

export async function deleteSkillForUi(cfg: AppConfig, skillId: string): Promise<void> {
  const dir = path.join(cfg.paths.skills, skillId);
  if (!(await pathExists(dir))) {
    throw new Error("skill_missing");
  }
  await fs.rm(dir, { recursive: true, force: true });
  await writeSkillIndex(cfg, await loadSkills(cfg));
}

export async function listContactsForUi(cfg: AppConfig): Promise<ContactRecord[]> {
  const entries = await fs.readdir(cfg.paths.contacts, { withFileTypes: true }).catch(() => []);
  const out: ContactRecord[] = [];
  for (const sourceEntry of entries) {
    if (!sourceEntry.isDirectory()) continue;
    const source = sourceEntry.name;
    const sourceDir = path.join(cfg.paths.contacts, source);
    const files = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const userId = file.name.slice(0, -3);
      const contact = await loadContact(cfg, source, userId);
      if (!(await pathExists(contactPath(cfg, source, userId)))) continue;
      out.push(contact);
    }
  }
  return out.sort((a, b) => `${a.source}:${a.user_id}`.localeCompare(`${b.source}:${b.user_id}`));
}

export async function loadContactForUi(
  cfg: AppConfig,
  source: string,
  userId: string,
): Promise<ContactRecord | null> {
  const file = contactPath(cfg, source, userId);
  if (!(await pathExists(file))) return null;
  return loadContact(cfg, source, userId);
}

export async function saveContactForUi(
  cfg: AppConfig,
  source: string,
  userId: string,
  patch: Partial<ContactRecord>,
): Promise<ContactRecord> {
  const file = contactPath(cfg, source, userId);
  if (!(await pathExists(file))) {
    throw new Error("contact_missing");
  }
  const current = await loadContact(cfg, source, userId);
  const next: ContactRecord = {
    ...current,
    ...patch,
    source,
    user_id: userId,
    allowed_permissions: normalizeList(patch.allowed_permissions ?? current.allowed_permissions),
  };
  await saveContact(cfg, next);
  return next;
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

async function buildSessionSummary(thread: ThreadHandle, session?: SessionState): Promise<SessionSummary> {
  const current = session ?? (await loadSessionState(thread));
  return {
    threadKey: thread.state.thread_key,
    source: thread.state.source,
    harness: "Codex",
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
  return {
    id: skillId,
    name: input.name,
    description: input.description,
    permissions: normalizePermissions(input.permissions),
  };
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

function normalizeList(value: string[]): string[] {
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function fsDateFromName(name: string): string {
  return name.replace(/\.md$/, "");
}
