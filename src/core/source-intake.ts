import path from "node:path";
import type { AppConfig } from "../config.js";
import { ensureDir, safeFileName, writeTextAtomic } from "../lib/fs.js";
import { fsTimestamp } from "../lib/time.js";
import {
  routeOwnerDecisionFromEvent,
  routeOwnerDecisionFromReaction,
  type OwnerDecisionRoute,
} from "../slices/approvals/index.js";
import { findThreadHandle, hasThreadEvent } from "../slices/sessions/index.js";
import type { OwnerDecision, SourceMessageAnchor, UniversalEvent } from "../types.js";
import { sourceRawDir } from "../workspace.js";

export interface SourceIntakePorts {
  ingest(event: UniversalEvent): Promise<void>;
  handleOwnerDecision(decision: OwnerDecision): Promise<boolean>;
}

export type SourceEventIntakeResult =
  | { kind: "duplicate" }
  | { kind: "ingested" }
  | { kind: "owner_decision"; handled: true }
  | { kind: "owner_decision"; handled: false; ingested: true }
  | { kind: "owner_non_decision"; route: Exclude<OwnerDecisionRoute["kind"], "routed">; ingested: true };

export type SourceReactionIntakeResult =
  | { kind: "owner_decision"; handled: boolean }
  | { kind: "not_decision" }
  | { kind: "no_pending_approval" };

export async function handleSourceEventIntake(
  cfg: AppConfig,
  input: {
    event: UniversalEvent;
    ports: SourceIntakePorts;
    owner?: {
      decidedBy: string;
      anchor?: SourceMessageAnchor;
    };
  },
): Promise<SourceEventIntakeResult> {
  const duplicate = await isDurableDuplicate(cfg, input.event);
  if (duplicate) return { kind: "duplicate" };

  await persistSourceEvidence(cfg, input.event);

  if (input.owner) {
    const routed = await routeOwnerDecisionFromEvent(cfg, {
      event: input.event,
      decidedBy: input.owner.decidedBy,
      anchor: input.owner.anchor,
    });
    if (routed.kind === "routed") {
      const handled = await input.ports.handleOwnerDecision(routed.decision);
      if (handled) return { kind: "owner_decision", handled: true };
      await input.ports.ingest(input.event);
      return { kind: "owner_decision", handled: false, ingested: true };
    }
    await input.ports.ingest(input.event);
    return { kind: "owner_non_decision", route: routed.kind, ingested: true };
  }

  await input.ports.ingest(input.event);
  return { kind: "ingested" };
}

export async function handleSourceReactionIntake(
  cfg: AppConfig,
  input: {
    source: string;
    token: string;
    anchor: SourceMessageAnchor;
    decidedBy: string;
    ports: SourceIntakePorts;
  },
): Promise<SourceReactionIntakeResult> {
  const routed = await routeOwnerDecisionFromReaction(cfg, {
    source: input.source,
    token: input.token,
    anchor: input.anchor,
    decidedBy: input.decidedBy,
  });
  if (routed.kind !== "routed") return { kind: routed.kind };
  return {
    kind: "owner_decision",
    handled: await input.ports.handleOwnerDecision(routed.decision),
  };
}

async function isDurableDuplicate(cfg: AppConfig, event: UniversalEvent): Promise<boolean> {
  const thread = await findThreadHandle(cfg, event.thread_key, event.source);
  return thread ? hasThreadEvent(thread, event.source, event.event_id) : false;
}

async function persistSourceEvidence(cfg: AppConfig, event: UniversalEvent): Promise<string> {
  const dir = sourceRawDir(cfg.paths, event.source);
  await ensureDir(dir);
  const file = path.join(
    dir,
    `${fsTimestamp(new Date(event.received_at))}_${safeFileName(event.event_id)}.json`,
  );
  event.raw_path = file;
  await writeTextAtomic(file, JSON.stringify(event, null, 2));
  return file;
}
