import type { AppConfig } from "../../config.js";
import type { OwnerDecision } from "../../types.js";
import { decideApproval, findPendingApproval, type ApprovalRecord, type PermissionGrant } from "./registry.js";
import { grantPermissions } from "../contacts/index.js";
import type { ThreadHandle } from "../sessions/index.js";
import { log } from "../../lib/log.js";

export interface AppliedOwnerDecision {
  thread: ThreadHandle;
  decisionFile: string;
  record: ApprovalRecord | null;
  grant?: PermissionGrant;
  at: string;
}

/**
 * Apply an {@link OwnerDecision} end to end: resolve the exact pending target,
 * record the verdict, and — only on an "always" decision — persist the contact
 * grant. Returns null when no pending request matches (already decided, or the
 * target could not be resolved). The caller owns replaying the decision event
 * into a turn; this owns the domain consequence.
 *
 * `approvals` stays decoupled from `contacts`: `decideApproval` names the grant
 * intent, and this orchestrator is the one place that turns that intent into a
 * persisted grant.
 */
export async function applyOwnerDecision(
  cfg: AppConfig,
  decision: OwnerDecision,
): Promise<AppliedOwnerDecision | null> {
  const pendingApproval = await findPendingApproval(cfg, decision.target);
  if (!pendingApproval) {
    log.warn("owner.permission_thread_not_found", { target: decision.target });
    return null;
  }
  const { thread, request } = pendingApproval;
  const at = new Date().toISOString();
  const { decisionFile, record, grant } = await decideApproval(
    cfg,
    thread,
    request,
    { mode: decision.mode },
    decision.decidedBy,
    at,
  );
  if (grant) {
    await grantPermissions(cfg, grant.requester, grant.permissions);
  }
  return { thread, decisionFile, record, grant, at };
}
