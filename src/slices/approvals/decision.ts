import type { PermissionDecision } from "../../types.js";
import type { AppConfig } from "../../config.js";
import { classifyOwnerDecisionViaCodex } from "./classify.js";

/**
 * The owner's reply grammar for a pending permission request. Pure — adapters
 * call this to recognise a decision message; the engine and tests share the
 * same vocabulary. Returns null when the text is not a decision at all.
 */
export function parseOwnerDecision(text: string): PermissionDecision | null {
  const trimmed = text.trim();
  if (/^OK once$/i.test(trimmed)) return { mode: "once" };
  if (/^OK always$/i.test(trimmed)) return { mode: "always" };
  if (/^REJECT$/i.test(trimmed)) return { mode: "reject" };
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
  const classified = await classifyOwnerDecisionViaCodex(text, cfg);
  if (!classified) return null;
  return { mode: classified };
}
