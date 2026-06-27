import type { AppConfig } from "../../config.js";
import { findPendingApproval, listPendingApprovals } from "./registry.js";
import type { ThreadHandle } from "../sessions/index.js";
import type { OwnerDecisionTarget, SessionPermissionRequest } from "../../types.js";

export interface PendingPermissionThread {
  thread: ThreadHandle;
  pending: SessionPermissionRequest;
}

export async function listPendingPermissionThreads(cfg: AppConfig): Promise<PendingPermissionThread[]> {
  return (await listPendingApprovals(cfg)).map((pending) => ({
    thread: pending.thread,
    pending: pending.request,
  }));
}

/**
 * Legacy resolver that still allows the owner-message fallback for older
 * call sites. New decision flows should use {@link resolvePendingPermissionThreadExact}.
 */
export async function resolvePendingPermissionThread(
  cfg: AppConfig,
  target: OwnerDecisionTarget,
): Promise<ThreadHandle | null> {
  return (await findPendingApproval(cfg, target, { allowUnanchoredOwnerMessageFallback: true }))?.thread ?? null;
}

export async function resolvePendingPermissionThreadExact(
  cfg: AppConfig,
  target: OwnerDecisionTarget,
): Promise<ThreadHandle | null> {
  return (await findPendingApproval(cfg, target))?.thread ?? null;
}
