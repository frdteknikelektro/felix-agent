import type { AppConfig } from "../../config.js";
import type { OwnerDecision, SourceMessageAnchor, UniversalEvent } from "../../types.js";
import { parseDecisionToken } from "../../core/decision.js";
import { parseOwnerDecisionAsync } from "./decision.js";
import { resolvePendingPermissionThreadExact } from "./resolve.js";

export type OwnerDecisionRoute =
  | { kind: "routed"; decision: OwnerDecision }
  | { kind: "not_decision" }
  | { kind: "no_pending_approval" };

export type OwnerDecisionCandidate =
  | { kind: "candidate"; decision: OwnerDecision }
  | { kind: "not_decision" };

export async function routeOwnerDecisionFromEvent(
  cfg: AppConfig,
  input: {
    event: UniversalEvent;
    decidedBy: string;
    anchor?: SourceMessageAnchor;
  },
): Promise<OwnerDecisionRoute> {
  const parsed = await parseOwnerDecisionAsync(input.event.text, cfg);
  if (!parsed) return { kind: "not_decision" };
  return routeParsedOwnerDecision(cfg, {
    mode: parsed.mode,
    decidedBy: input.decidedBy,
    anchor: input.anchor ?? ownerMessageAnchorFromEvent(input.event),
  });
}

export async function routeOwnerDecisionFromReaction(
  cfg: AppConfig,
  input: {
    source: string;
    token: string;
    anchor: SourceMessageAnchor;
    decidedBy: string;
  },
): Promise<OwnerDecisionRoute> {
  const candidate = ownerDecisionCandidateFromReaction(input);
  if (candidate.kind === "not_decision") return candidate;
  return routeOwnerDecisionCandidate(cfg, candidate.decision);
}

export function ownerDecisionCandidateFromReaction(input: {
  source: string;
  token: string;
  anchor: SourceMessageAnchor;
  decidedBy: string;
}): OwnerDecisionCandidate {
  const mode = parseDecisionToken(input.token);
  if (!mode) return { kind: "not_decision" };
  return {
    kind: "candidate",
    decision: ownerDecisionFromParts({
      mode,
      decidedBy: input.decidedBy,
      anchor: { ...input.anchor, source: input.anchor.source || input.source },
    }),
  };
}

export function isOwnerDecisionReactionToken(token: string): boolean {
  return parseDecisionToken(token) !== null;
}

export async function routeOwnerDecisionCandidate(
  cfg: AppConfig,
  decision: OwnerDecision,
): Promise<OwnerDecisionRoute> {
  const found = await resolvePendingPermissionThreadExact(cfg, decision.target);
  if (!found) return { kind: "no_pending_approval" };
  return { kind: "routed", decision };
}

async function routeParsedOwnerDecision(
  cfg: AppConfig,
  input: {
    mode: OwnerDecision["mode"];
    decidedBy: string;
    anchor: SourceMessageAnchor;
  },
): Promise<OwnerDecisionRoute> {
  return routeOwnerDecisionCandidate(cfg, ownerDecisionFromParts(input));
}

function ownerDecisionFromParts(input: {
  mode: OwnerDecision["mode"];
  decidedBy: string;
  anchor: SourceMessageAnchor;
}): OwnerDecision {
  return {
    mode: input.mode,
    decidedBy: input.decidedBy,
    target: {
      kind: "owner_message",
      anchor: input.anchor,
    },
  };
}

function ownerMessageAnchorFromEvent(event: UniversalEvent): SourceMessageAnchor {
  return {
    source: event.source,
    conversation_id: event.source_thread_ref.conversation_id,
    message_id: event.source_thread_ref.root_message_id ?? event.source_thread_ref.message_id,
    thread_id: event.source_thread_ref.thread_id,
  };
}
