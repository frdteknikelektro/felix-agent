import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readJsonParsed, writeJsonAtomic } from "../../lib/fs.js";
import { appendFelixReply, appendPermissionEvent, appendPermissionRequest, setPendingPermission, type ThreadHandle } from "../sessions/index.js";
import { ApprovalRecordSchema } from "../../core/schemas.js";
import type { ApprovalRecord, SourceSender } from "../../core/schemas.js";
import type { PermissionDecision, SessionPermissionRequest } from "../../types.js";

export type { ApprovalRecord };

export async function saveApprovalRecord(cfg: AppConfig, record: ApprovalRecord): Promise<ApprovalRecord> {
  const file = approvalRecordPath(cfg, record.threadKey, record.requestId);
  await ensureDir(path.dirname(file));
  await writeJsonAtomic(file, record);
  return record;
}

export async function loadApprovalRecord(
  cfg: AppConfig,
  threadKey: string,
  requestId: string,
): Promise<ApprovalRecord | null> {
  const file = approvalRecordPath(cfg, threadKey, requestId);
  if (!(await pathExists(file))) return null;
  return readJsonParsed(file, ApprovalRecordSchema, null as unknown as ApprovalRecord);
}

export async function upsertApprovalDecision(
  cfg: AppConfig,
  threadKey: string,
  requestId: string,
  patch: Partial<Pick<ApprovalRecord, "status" | "decidedAt" | "decisionPath" | "ownerUserId">>,
): Promise<ApprovalRecord | null> {
  const current = await loadApprovalRecord(cfg, threadKey, requestId);
  if (!current) return null;
  const next: ApprovalRecord = { ...current, ...patch };
  await saveApprovalRecord(cfg, next);
  return next;
}

export async function listApprovalRecords(cfg: AppConfig): Promise<ApprovalRecord[]> {
  await ensureDir(cfg.paths.approvals);
  const out: ApprovalRecord[] = [];
  const entries = await fs.readdir(cfg.paths.approvals, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const threadDir = path.join(cfg.paths.approvals, entry.name);
    const files = await fs.readdir(threadDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const record = await readJsonParsed(
        path.join(threadDir, file.name),
        ApprovalRecordSchema,
        null as unknown as ApprovalRecord,
      );
      if (!record) continue;
      out.push(record);
    }
  }
  return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export interface PermissionGrant {
  requester: SourceSender;
  skillId: string;
  permissions: string[];
}

export interface ApprovalDecisionResult {
  record: ApprovalRecord | null;
  decisionFile: string;
  grant?: PermissionGrant;
}

export async function requestApproval(
  cfg: AppConfig,
  thread: ThreadHandle,
  request: SessionPermissionRequest,
): Promise<ApprovalRecord> {
  await setPendingPermission(thread, request);
  const record = approvalRecordFromRequest(thread, request);
  await saveApprovalRecord(cfg, record);
  await appendPermissionRequestEvent(thread, request);
  return record;
}

export async function decideApproval(
  cfg: AppConfig,
  thread: ThreadHandle,
  pending: SessionPermissionRequest,
  decision: PermissionDecision,
  ownerUserId: string,
  at: string,
): Promise<ApprovalDecisionResult> {
  const requestId = pending.request_id ?? pending.requester_event_file;

  if (decision.mode === "reject") {
    const decisionFile = await appendPermissionEvent(thread, at, "rejected", {
      owner_user_id: ownerUserId,
      request_id: pending.request_id,
      skill_id: pending.skill_id,
      permissions: pending.permissions,
      scope: "once",
      source_thread_ref: thread.state.source_thread_ref,
      reason: pending.reason,
    });
    const record = await upsertApprovalDecision(cfg, thread.state.thread_key, requestId, {
      status: "rejected",
      decidedAt: at,
      decisionPath: decisionFile,
      ownerUserId,
    });
    await setPendingPermission(thread, null);
    return { record, decisionFile };
  }

  const scope = decision.mode === "always" ? "always" : "once";
  const decisionFile = await appendPermissionEvent(thread, at, "approved", {
    owner_user_id: ownerUserId,
    request_id: pending.request_id,
    skill_id: pending.skill_id,
    permissions: pending.permissions,
    scope,
    source_thread_ref: thread.state.source_thread_ref,
    reason: pending.reason,
  });
  const grant: PermissionGrant | undefined =
    decision.mode === "always"
      ? { requester: pending.requester, skillId: pending.skill_id, permissions: pending.permissions }
      : undefined;
  await setPendingPermission(thread, null);
  const record = await upsertApprovalDecision(cfg, thread.state.thread_key, requestId, {
    status: "approved",
    decidedAt: at,
    decisionPath: decisionFile,
    ownerUserId,
  });
  return { record, decisionFile, grant };
}

function approvalRecordFromRequest(thread: ThreadHandle, request: SessionPermissionRequest): ApprovalRecord {
  const id = request.request_id ?? request.requester_event_file;
  return {
    id,
    requestId: id,
    threadKey: thread.state.thread_key,
    source: thread.state.source,
    status: "pending",
    requestedAt: request.requested_at,
    skillId: request.skill_id,
    permissions: request.permissions,
    reason: request.reason,
    ownerMessage: request.owner_message,
    requester: request.requester,
    ownerMessageAnchor: request.owner_message_anchor,
    requestPath: request.requester_event_file,
  };
}

async function appendPermissionRequestEvent(
  thread: ThreadHandle,
  request: SessionPermissionRequest,
): Promise<void> {
  await appendPermissionRequest(thread, request);
  await appendFelixReply(
    thread,
    new Date().toISOString(),
    `Permission requested for ${request.skill_id}. Waiting for owner approval.`,
  );
}

function approvalRecordPath(cfg: AppConfig, threadKey: string, requestId: string): string {
  return path.join(cfg.paths.approvals, safeSegment(threadKey), `${safeSegment(requestId)}.json`);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
