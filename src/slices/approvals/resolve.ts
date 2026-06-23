import type { AppConfig } from "../../config.js";
import { listThreadHandles, loadSessionState, type ThreadHandle } from "../sessions/index.js";
import type { OwnerDecisionTarget, SessionPermissionRequest } from "../../types.js";

export interface PendingPermissionThread {
  thread: ThreadHandle;
  pending: SessionPermissionRequest;
}

export async function listPendingPermissionThreads(cfg: AppConfig): Promise<PendingPermissionThread[]> {
  const threads = await listThreadHandles(cfg);
  const out: PendingPermissionThread[] = [];
  for (const thread of threads) {
    const session = await loadSessionState(thread);
    if (session.pending_permission) {
      out.push({ thread, pending: session.pending_permission });
    }
  }
  return out;
}

/**
 * Legacy resolver that still allows the owner-message fallback for older
 * call sites. New decision flows should use {@link resolvePendingPermissionThreadExact}.
 */
export async function resolvePendingPermissionThread(
  cfg: AppConfig,
  target: OwnerDecisionTarget,
): Promise<ThreadHandle | null> {
  const pendings = await listPendingPermissionThreads(cfg);

  if (target.kind === "thread") {
    const threadKey = target.threadKey.trim();
    return pendings.find((p) => p.thread.state.thread_key === threadKey)?.thread ?? null;
  }

  if (target.kind === "approval") {
    const approvalId = target.approvalId.trim();
    if (!approvalId) return null;
    return pendings.find((p) => approvalIdsMatch(p.pending, approvalId))?.thread ?? null;
  }

  const byAnchor = pendings.find((p) => anchorsMatch(p.pending.owner_message_anchor, target.anchor));
  if (byAnchor) {
    return byAnchor.thread;
  }
  return pendings.find((p) => !p.pending.owner_message_anchor)?.thread ?? null;
}

export async function resolvePendingPermissionThreadExact(
  cfg: AppConfig,
  target: OwnerDecisionTarget,
): Promise<ThreadHandle | null> {
  const pendings = await listPendingPermissionThreads(cfg);

  if (target.kind === "thread") {
    const threadKey = target.threadKey.trim();
    return pendings.find((p) => p.thread.state.thread_key === threadKey)?.thread ?? null;
  }

  if (target.kind === "approval") {
    const approvalId = target.approvalId.trim();
    if (!approvalId) return null;
    return pendings.find((p) => approvalIdsMatch(p.pending, approvalId))?.thread ?? null;
  }

  return pendings.find((p) => anchorsMatch(p.pending.owner_message_anchor, target.anchor))?.thread ?? null;
}

function anchorsMatch(
  pending: SessionPermissionRequest["owner_message_anchor"],
  target: Extract<OwnerDecisionTarget, { kind: "owner_message" }>["anchor"],
): boolean {
  if (!pending?.message_id || !target.message_id) return false;
  if (pending.source !== target.source) return false;
  if (pending.message_id !== target.message_id) return false;
  if (pending.conversation_id && target.conversation_id && pending.conversation_id !== target.conversation_id) {
    return false;
  }
  if (pending.thread_id && target.thread_id && pending.thread_id !== target.thread_id) {
    return false;
  }
  return true;
}

function approvalIdsMatch(
  pending: SessionPermissionRequest,
  approvalId: string,
): boolean {
  if (!approvalId) return false;
  return pending.request_id === approvalId || pending.requester_event_file === approvalId;
}
