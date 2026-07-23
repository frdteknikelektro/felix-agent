import type { TurnResult } from "./ports.js";

/**
 * The engine's decision for a single turn attempt. Describes intent only —
 * no IO, no side effects. The engine shell executes each case through ports.
 *
 * retry_fresh  — resume failed; discard codex session and try once more from a
 *               clean start. Only fired when resumed=true and not yet retried.
 * fail         — harness produced no usable output; requeue the event.
 * reply        — send the text and record the turn.
 * no_skill     — no matching skill; send the canned "I don't have the skill" reply.
 * permission_required — surface the permission request to the owner.
 * format_retry — permission block is malformed; ask the LLM to fix formatting.
 * fallback     — unrecognised output shape; echo the text as a best-effort reply.
 */
export type TurnDecision =
  | { kind: "retry_fresh" }
  | { kind: "fail" }
  | { kind: "reply" }
  | { kind: "no_skill" }
  | { kind: "permission_required" }
  | { kind: "format_retry" }
  | { kind: "fallback" };

/**
 * Pure function: given a harness result and the resume context, return the
 * engine's next action. No IO, no logging — the caller logs what it needs.
 */
export function decideTurnResult(
  result: TurnResult,
  resumed: boolean,
  retriedFreshStart: boolean,
): TurnDecision {
  if (!result.success && resumed && !retriedFreshStart) {
    return { kind: "retry_fresh" };
  }
  if (!result.success) {
    return { kind: "fail" };
  }
  switch (result.parsed.kind) {
    case "reply":
      return { kind: "reply" };
    case "no_skill":
      return { kind: "no_skill" };
    case "permission_required":
      return { kind: "permission_required" };
    case "format_error":
      return { kind: "format_retry" };
    default:
      return { kind: "fallback" };
  }
}
