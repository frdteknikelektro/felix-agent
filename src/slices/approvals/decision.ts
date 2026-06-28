import type { PermissionDecision } from "../../types.js";
import type { AppConfig } from "../../config.js";
import { classifyOwnerDecision } from "./classify.js";
import { parseDecisionToken } from "../../core/decision.js";

/**
 * The owner's reply grammar for a pending permission request. Pure — adapters
 * call this to recognise a decision message; the engine and tests share the
 * same vocabulary. Returns null when the text is not a decision at all.
 */
export function parseOwnerDecision(text: string): PermissionDecision | null {
  const trimmed = text.trim();
  const symbol = parseDecisionToken(trimmed);
  if (symbol) return { mode: symbol };
  if (/^yes$/i.test(trimmed)) return { mode: "once" };
  if (/^always$/i.test(trimmed)) return { mode: "always" };
  if (/^no$/i.test(trimmed)) return { mode: "reject" };
  if (/^OK once$/i.test(trimmed)) return { mode: "once" };
  if (/^OK always$/i.test(trimmed)) return { mode: "always" };
  if (/^REJECT$/i.test(trimmed)) return { mode: "reject" };
  return null;
}

/**
 * The owner-console action grammar: maps a REST action ("approve"/"reject") plus
 * an approval scope ("once"/"always") to a decision mode. Pure — the single home
 * for this mapping so HTTP routes never hand-roll it. A bare valid mode passed as
 * the action ("once"/"always"/"reject") is accepted as-is. Returns null when the
 * action is not a recognised decision.
 */
export function ownerDecisionFromAction(
  action: string,
  scope: string,
): PermissionDecision["mode"] | null {
  if (action === "reject") return "reject";
  if (action === "approve") return scope === "always" ? "always" : "once";
  if (action === "once" || action === "always") return action;
  return null;
}

/**
 * Async wrapper that first tries the exact regex match, then falls back to
 * the Codex LLM to classify natural-language decisions. Requires `cfg` to
 * provide Codex auth settings.
 */
export async function parseOwnerDecisionAsync(
  text: string,
  cfg: AppConfig,
): Promise<PermissionDecision | null> {
  const exact = parseOwnerDecision(text);
  if (exact) return exact;
  const classified = await classifyOwnerDecision(text, cfg);
  if (!classified) return null;
  return { mode: classified };
}
