import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { TurnInput, ParsedAgentOutput, DecisionNotificationInput, TurnUsage } from "./ports.js";
import { skillMatchesPermission } from "../slices/skills/index.js";
import { decisionEmoji, decisionLabel } from "./decision.js";
import { contactPath } from "../slices/contacts/index.js";
import { buildInitialMd } from "./initial-md.js";



/**
 * Build a normalized {@link TurnUsage} from loosely-typed token counts parsed
 * out of a harness CLI stream. Coerces missing/invalid numbers to 0 and returns
 * null when no token data was present, so callers never have to special-case the
 * "harness emitted no usage" path. `total` excludes cache_read (discounted reuse).
 */
export function normalizeUsage(parts: {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  model?: unknown;
}): TurnUsage | null {
  const input = toCount(parts.input);
  const output = toCount(parts.output);
  const cache_read = toCount(parts.cache_read);
  const cache_write = toCount(parts.cache_write);
  const model = typeof parts.model === "string" && parts.model ? parts.model : null;
  if (input === 0 && output === 0 && cache_read === 0 && cache_write === 0) {
    return null;
  }
  return { input, output, cache_read, cache_write, total: input + output + cache_write, model };
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function parseAgentOutput(raw: string): ParsedAgentOutput {
  const text = raw.trim();

  const perm = extractPermissionBlock(text);
  if (perm) {
    const missing: string[] = [];
    const blockMissingEnd = !text.includes("END_PERMISSION_REQUIRED");
    if (blockMissingEnd) missing.push("END_PERMISSION_REQUIRED");
    if (!perm.skillId) missing.push("skill:");
    if (perm.permissions.length === 0) missing.push("permissions list (at least one `- <permission>` line)");
    if (missing.length > 0) {
      return {
        kind: "format_error",
        text: `PERMISSION_REQUIRED block is malformed — missing: ${missing.join(", ")}. Expected format:\nPERMISSION_REQUIRED\nskill: <skill id>\npermissions:\n- <permission>\nreason: <short reason>\nowner_message: <short owner request>\nEND_PERMISSION_REQUIRED`,
      };
    }
    const reply = between(text, "FELIX_REPLY", "END_FELIX_REPLY");
    return {
      kind: "permission_required",
      text: reply?.trim() || perm.userMessage || "Waiting for owner permission.",
      skillId: perm.skillId,
      permissions: perm.permissions,
      reason: perm.reason,
      ownerMessage: perm.ownerMessage,
    };
  }

  const reply = between(text, "FELIX_REPLY", "END_FELIX_REPLY");
  if (reply) {
    return { kind: "reply", text: reply.trim() };
  }

  const noSkill = text.match(/I don't have the skill yet\./i);
  if (noSkill) {
    return { kind: "no_skill", text: "I don't have the skill yet." };
  }

  return { kind: "unknown", text };
}

export function hasRenderableOutput(output: ParsedAgentOutput): boolean {
  return output.text.trim().length > 0;
}

/**
 * Build the turn prompt — returns the per-turn message.
 *
 * On the first turn of a new session, writes INITIAL.md to the thread directory
 * (once per session, never rewritten for resumed turns).
 */
export async function buildTurnPrompt(
  cfg: AppConfig,
  input: TurnInput,
  sessionId: string,
): Promise<string> {
  const initialPath = path.join(input.thread.dir, "INITIAL.md");
  const already = await fs.stat(initialPath).catch(() => null);
  if (!already) {
    await buildInitialMd({
      cfg,
      sessionId,
      harnessType: cfg.HARNESS,
      threadDir: input.thread.dir,
      behaviorInstructions: input.sourceContext.behaviorInstructions,
    });
  }
  return buildPerTurnMessage(cfg, input);
}

/**
 * Minimal per-turn message — resolved paths the model can't reliably derive
 * (cwd ≠ thread dir; contact path applies safeFileName), plus the new event.
 * Everything else (the behavior contract, session context, permission events,
 * transcript) is read from disk by the model rather than injected.
 */
function buildPerTurnMessage(cfg: AppConfig, input: TurnInput): string {
  const lines: string[] = [
    `thread_dir: ${input.thread.dir}`,
    `initial_md: ${path.join(input.thread.dir, "INITIAL.md")}`,
    `transcript: ${input.thread.transcriptFile}`,
    `contact_file: ${contactPath(cfg, input.event.sender.source, input.event.sender.id)}`,
    `event_file: ${input.eventFile}`,
    `visibility: ${input.event.visibility}`,
    `mentions_bot: ${input.event.mentions_bot}`,
    `source_thread_ref: ${JSON.stringify(input.event.source_thread_ref)}`,
    `sender: ${input.event.sender.source}:${input.event.sender.id}${input.event.sender.display ? ` (${input.event.sender.display})` : ""}`,
    `text: ${input.event.text}`,
  ];

  if (input.event.attachments.length > 0) {
    lines.push(`attachments: ${formatAttachmentsForPrompt(input.event.attachments)}`);
  }

  if (input.precedingEvents?.length) {
    lines.push("preceding (already in transcript):");
    for (const e of input.precedingEvents) {
      const attach = formatAttachmentsForPrompt(e.event.attachments);
      lines.push(
        `  - event_file: ${e.eventFile} sender: ${e.event.sender.source}:${e.event.sender.id}${e.event.sender.display ? ` (${e.event.sender.display})` : ""} text: ${e.event.text} attachments: ${attach}`,
      );
    }
  }

  // Server-computed permission gate for this requester. Authoritative — the
  // model must not re-derive have/need from disk when this block is present.
  const skillPermLines = input.skills
    .filter((skill) => skill.permissions.length > 0)
    .map((skill) => {
      const grantedBare = skill.permissions
        .filter((p) => input.contact.allowed_permissions.includes(p))
        .map((p) => p.replace(`${skill.id}:`, ""));
      const missingBare = skill.permissions
        .filter((p) => !input.contact.allowed_permissions.includes(p))
        .map((p) => p.replace(`${skill.id}:`, ""));
      return `  - ${skill.id}: have=[${grantedBare.join(", ") || "none"}], need=[${missingBare.join(", ") || "none"}]${missingBare.length === 0 ? " — all permissions granted" : ""}`;
    });
  if (skillPermLines.length > 0) {
    lines.push(
      "permissions_per_skill (server-computed — authoritative, do not re-derive): have=[...] is pre-authorized; for anything under need=[...] emit PERMISSION_REQUIRED first.",
      ...skillPermLines,
    );
  }

  return lines.join("\n");
}

function formatAttachmentsForPrompt(attachments: TurnInput["event"]["attachments"]): string {
  if (attachments.length === 0) return "(none)";
  return attachments
    .map((attachment) => {
      if (attachment.status === "rejected") {
        return `${attachment.filename} [rejected: ${attachment.rejected_reason ?? "not available"}]`;
      }
      return `${attachment.local_path ?? attachment.filename}${attachment.content_type ? ` (${attachment.content_type})` : ""}`;
    })
    .join(", ");
}

export function skillSatisfiesPermissions(skill: import("../types.js").SkillRecord, permissions: string[]): boolean {
  return skillMatchesPermission(skill, permissions);
}

export function extractPermissionBlock(text: string): {
  raw: string;
  userMessage: string;
  skillId?: string;
  permissions: string[];
  reason?: string;
  ownerMessage?: string;
} | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "PERMISSION_REQUIRED");
  if (start < 0) return null;
  const end = lines.findIndex((line, idx) => idx > start && line.trim() === "END_PERMISSION_REQUIRED");
  const userMessage = lines.slice(0, start).join("\n").trim();
  const slice = lines.slice(start + 1, end > start ? end : undefined);
  const map = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of slice) {
    if (/^[a-z_]+:/i.test(line)) {
      const idx = line.indexOf(":");
      current = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      map.set(current, value ? [value] : []);
      continue;
    }
    if (line.trim().startsWith("-") && current) {
      const value = line.replace(/^\s*-\s*/, "").trim();
      map.get(current)?.push(value);
    }
  }
  return {
    raw: slice.join("\n"),
    userMessage,
    skillId: map.get("skill")?.[0],
    permissions: map.get("permissions") ?? [],
    reason: map.get("reason")?.[0],
    ownerMessage: map.get("owner_message")?.join("\n"),
  };
}

export function between(text: string, startMarker: string, endMarker: string): string | null {
  const end = text.lastIndexOf(endMarker);
  if (end < 0) return null;
  const start = text.lastIndexOf(startMarker, end);
  if (start < 0) return null;
  const after = start + startMarker.length;
  return text.slice(after, end);
}

export function contactFilePath(cfg: AppConfig, source: string, userId: string): string {
  return path.join(cfg.paths.contacts, source, `${userId.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`);
}

export function buildSpawnPath(cfg: AppConfig): string {
  const localBin = path.resolve(process.cwd(), "node_modules", ".bin");
  const current = process.env.PATH ?? "";
  const pythonBin = path.join(cfg.paths.python, "bin");
  const existing = new Set(current.split(":").filter(Boolean));
  const prepend = [localBin, cfg.paths.bin, pythonBin].filter((p) => !existing.has(p));
  return prepend.length > 0 ? `${prepend.join(":")}:${current}` : current;
}

export function buildDecisionNotificationPrompt(input: DecisionNotificationInput): string {
  const owner = input.ownerDisplay ?? "your owner";
  const lines = [
    "You are Felix, replying in a conversation thread.",
    `${owner} just ${input.mode === "reject" ? "rejected" : "approved"} a permission request for skill "${input.skillId}".`,
    input.reason ? `Reason: ${input.reason}` : "",
    input.mode === "reject"
      ? "Tell the user their request was denied. Reply concisely in the conversation's language. One sentence only."
      : `Tell the user permission was granted ${input.mode === "always" ? "permanently" : "for this request"}, and you're proceeding. Reply concisely in the conversation's language. One sentence only.`,
    "",
    "FELIX_REPLY",
    "<reply>",
    "END_FELIX_REPLY",
  ];
  return lines.join("\n");
}

export function fallbackNotification(mode: "once" | "always" | "reject"): string {
  if (mode === "reject") return "Permission denied.";
  return "Permission granted. Proceeding.";
}

export interface OwnerPermissionNotificationInput {
  skillId: string;
  permissions: string[];
  reason: string;
  requesterName: string;
  requesterId: string;
  threadLink?: string;
  status?: "pending" | "approved" | "rejected";
  decisionMode?: "once" | "always" | "reject";
  decidedAt?: string;
}

export function buildOwnerPermissionNotification(input: OwnerPermissionNotificationInput): string {
  const status = input.status ?? "pending";
  const rows: [string, string][] = [
    ["Requester", `**${input.requesterName}** (\`${input.requesterId}\`)`],
    ["Skill", `\`${input.skillId}\``],
    ["Permissions", input.permissions.map((p) => `\`${p}\``).join(", ")],
    ["Reason", input.reason],
    ["Status", `\`${status}\``],
  ];
  if (status !== "pending" && input.decisionMode) {
    rows.push(["Decision", `${decisionEmoji(input.decisionMode)} ${decisionLabel(input.decisionMode)}`]);
  }
  if (input.decidedAt) {
    rows.push(["Resolved at", input.decidedAt]);
  }
  if (input.threadLink) {
    rows.push(["Thread", `[Open Thread](${input.threadLink})`]);
  }

  const footer =
    status === "pending"
      ? [
          "Reply `yes` to approve once, `always` to always allow, or `no` to reject.",
          "You can also react with 👌 (once), 👍 (always), or 🙏 (reject).",
        ]
      : [
          `This request is resolved as **${status}**.`,
          "No further action is needed.",
        ];

  return [
    "**Permission Request**",
    "",
    "| Field | Value |",
    "|---|---|",
    ...rows.map((r) => `| **${r[0]}** | ${r[1]} |`),
    "",
    ...footer,
  ].join("\n");
}
