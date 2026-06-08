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
 * Locate the pending-permission thread an owner decision is aimed at.
 *
 * Precedence:
 *  - kind "thread": the pending thread whose key matches exactly.
 *  - kind "owner_message": the pending thread whose owner-notification anchor
 *    matches, else the first pending request that carries no owner-message
 *    anchor — the fallback for decisions arriving without an anchor.
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

  const byAnchor = pendings.find((p) => anchorsMatch(p.pending.owner_message_anchor, target.anchor));
  if (byAnchor) {
    return byAnchor.thread;
  }
  return pendings.find((p) => !p.pending.owner_message_anchor)?.thread ?? null;
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
