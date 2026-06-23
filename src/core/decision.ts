import type { PermissionDecision } from "../types.js";

const DECISION_EMOJI: Record<PermissionDecision["mode"], string> = {
  once: "👌",
  always: "👍",
  reject: "🙏",
};

const DECISION_LABEL: Record<PermissionDecision["mode"], string> = {
  once: "Once",
  always: "Always",
  reject: "Reject",
};

const DECISION_ALIASES: Record<string, PermissionDecision["mode"]> = {
  "👌": "once",
  "ok_hand": "once",
  "ok hand": "once",
  "okhand": "once",
  "thumbs up": "always",
  "thumbs_up": "always",
  "thumbsup": "always",
  "+1": "always",
  "👍": "always",
  "🙏": "reject",
  "pray": "reject",
  "prayer": "reject",
  "folded_hands": "reject",
  "folded hands": "reject",
};

export function decisionEmoji(mode: PermissionDecision["mode"]): string {
  return DECISION_EMOJI[mode];
}

export function decisionLabel(mode: PermissionDecision["mode"]): string {
  return DECISION_LABEL[mode];
}

export function parseDecisionEmoji(input: string): PermissionDecision["mode"] | null {
  const normalized = normalizeDecisionToken(input);
  if (!normalized) return null;
  const direct = DECISION_ALIASES[normalized];
  if (direct) return direct;
  const first = normalized.split(/\s+/)[0];
  if (first) {
    return DECISION_ALIASES[first] ?? null;
  }
  return null;
}

export function parseDecisionToken(input: string): PermissionDecision["mode"] | null {
  const normalized = normalizeDecisionToken(input);
  if (!normalized) return null;
  if (normalized === "once") return "once";
  if (normalized === "always") return "always";
  if (normalized === "reject") return "reject";
  return parseDecisionEmoji(normalized);
}

function normalizeDecisionToken(input: string): string {
  return input.trim().toLowerCase().replace(/^:+|:+$/g, "");
}
