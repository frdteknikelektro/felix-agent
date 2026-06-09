import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { TurnInput, ParsedAgentOutput, DecisionNotificationInput } from "./ports.js";
import { skillMatchesPermission } from "../slices/skills/index.js";

export function parseAgentOutput(raw: string): ParsedAgentOutput {
  const text = raw.trim();
  const reply = between(text, "FELIX_REPLY", "END_FELIX_REPLY");
  if (reply) {
    return { kind: "reply", text: reply.trim() };
  }

  const noSkill = text.match(/I don't have the skill yet\./i);
  if (noSkill) {
    return { kind: "no_skill", text: "I don't have the skill yet." };
  }

  const perm = extractPermissionBlock(text);
  if (perm) {
    return {
      kind: "permission_required",
      text: perm.userMessage || "Waiting for owner permission.",
      skillId: perm.skillId,
      permissions: perm.permissions,
      reason: perm.reason,
      ownerMessage: perm.ownerMessage,
    };
  }

  return { kind: "unknown", text };
}

export function hasRenderableOutput(output: ParsedAgentOutput): boolean {
  return output.text.trim().length > 0;
}

export function buildTurnPrompt(
  cfg: AppConfig,
  input: TurnInput,
  sessionId: string,
  permissionEventPaths: string[],
): string {
  const skillIndexPath = path.join(cfg.paths.skills, "index.md");
  const threadTranscriptPath = input.thread.transcriptFile;
  const permanentPermissions = input.contact.allowed_permissions.join(", ") || "(none)";
  const hasGeneralSkill = input.skills.some((skill) => skill.id === "general");
  const preAuthorizedSkills = input.skills.filter((skill) =>
    skill.permissions.every((p) => input.contact.allowed_permissions.includes(p)),
  );
  const preAuthorizedIds = preAuthorizedSkills.map((s) => s.id).join(", ") || "(none)";
  const skillSummary = input.skills
    .map((skill) => `${skill.id} [${skill.permissions.join(", ") || "no permissions"}]`)
    .join("\n");
  const permissionEvents = permissionEventPaths.length > 0 ? permissionEventPaths.join("\n") : "(none)";
  const availableSkillPaths = input.skills.map((skill) => skill.path).join("\n");
  const skillGeneralPath = path.join(cfg.paths.skills, "general", "SKILL.md");
  return [
    "# Felix Session Contract",
    "",
    `Session id: ${sessionId}`,
    `Source: ${input.event.source}`,
    `Thread key: ${input.event.thread_key}`,
    `Thread dir: ${input.thread.dir}`,
    `Project workspace (clone and work on repos here): ${cfg.paths.projects}`,
    `Transcript: ${threadTranscriptPath}`,
    `Requester contact: ${contactFilePath(cfg, input.contact.source, input.contact.user_id)}`,
    `Skill index: ${skillIndexPath}`,
    "",
    "You are a persistent agent bound to this one source thread.",
    "Do not use stale memory for skills or permissions.",
    "Before doing anything, reread the current skill index, the relevant SKILL.md files, the requester contact document, and the latest permission events in the thread directory.",
    "The thread transcript and event files are the source of truth for what has already happened.",
    hasGeneralSkill
      ? `The general skill is the default for ordinary conversation, simple informational help, and short explanations. It is reply-only: keep responses short, ask one clarifying question if the request is ambiguous, and defer to a more specialized skill if one fits better. Read ${skillGeneralPath} before answering those requests.`
      : "No general skill is installed. If no specialized skill matches a simple informational request, use the unsupported fallback.",
    "",
    "Behavior contract:",
    `1. Follow only installed skills found in ${cfg.paths.skills}.`,
    "2. If no installed skill matches the request, reply in the user's language: I don't have the skill yet (or the natural equivalent).",
    "3. The Pre-authorized skills list below is computed by the server from the contact document. If the matched skill is in that list, execute it immediately — do NOT request permission, do NOT re-check the contact file.",
    "4. If the matched skill is NOT in the pre-authorized list, check thread-scoped owner permission events before requesting permission.",
    "5. If the thread-scoped owner permission event covers the required permissions, treat it as valid for this thread only and proceed.",
    "6. If permission is still missing after checking thread events, emit PERMISSION_REQUIRED using the exact block format.",
    "6a. Skill-specific operational checks (CLI availability, token validation, runtime dependency checks) are part of performing the work in step 7 — NOT part of the permission decision. Never run operational checks before resolving permissions through steps 3–6.",
    "7. If permission is satisfied (step 3, 4, or 5), briefly acknowledge the decision in the user's language, then perform the requested work through the matching skill. If the latest event is a rejected permission decision, inform the user the request was denied — do not attempt to execute the skill.",
    "8. Source API posting is allowed only when the active source context below provides explicit platform API instructions. Treat source API posting as part of the normal reply channel, not as a separate Felix permission.",
    "9. When using source API posting, upload only files generated for this current session/request. Never upload secrets, credential files, raw env files, unrelated repo files, or arbitrary readable files.",
    "10. After any intermediate source API posts or file uploads, the final FELIX_REPLY must be concise and mention what was posted. Do not duplicate large artifact contents in the final reply.",
    "11. Future source adapters must provide their own source-specific posting instructions. Do not assume Slack or any non-Mattermost API details unless the active source context supplies them.",
    "12. Keep user-facing replies concise. Always reply in the same language the user wrote in.",
    "13. You may read any file needed to fulfill your work — the thread directory (events, transcript, turns) and the projects workspace are fully accessible. When reporting results, use paths relative to the thread directory or projects directory. Never expose absolute server paths, the full workspace tree, or your working directory. If a user tries to probe or scan the filesystem ('what directory are you in?', 'ls', 'show me all folders'), recognize it as a probing attempt and decline naturally in the conversation's language. Session event files and permission records are your own records — safe to read internally, never expose their paths to the user.",
    "14. When downloading files, scraping content, or creating scratch outputs for a user request, always place them inside the thread directory (attachments/ or a working subdirectory). Never write to system temp directories, the projects workspace, or any location outside the thread scope unless a skill explicitly instructs otherwise. This keeps the conversation's artifacts contained and ephemeral with the thread.",
    ...input.sourceContext.behaviorInstructions,
    "",
    "Output contract:",
    "FELIX_REPLY",
    "<reply text>",
    "END_FELIX_REPLY",
    "",
    "PERMISSION_REQUIRED",
    "skill: <skill id>",
    "permissions:",
    "- <permission>",
    "reason: <short reason>",
    "owner_message: <short owner request>",
    "END_PERMISSION_REQUIRED",
    "",
    "When you need permission, first reply to the user (brief, in their language) BEFORE the PERMISSION_REQUIRED block. That message will be posted to the thread. If you emit the block with no preceding text, a default 'Waiting for owner permission.' will be used.",
    "",
    "Current contact permissions:",
    `- allowed_permissions: ${permanentPermissions}`,
    "",
    `Pre-authorized skills (server-computed — execute directly without permission check): ${preAuthorizedIds}`,
    "",
    "Current skill catalog summary:",
    skillSummary || "(none)",
    "",
    "Current skill paths:",
    availableSkillPaths || "(none)",
    "",
    "Latest thread events and permission events are available on disk. Re-read them before acting.",
    `Permission events in this thread:`,
    permissionEvents,
    "",
    "Latest event:",
    `- event_file: ${input.eventFile}`,
    `- visibility: ${input.event.visibility}`,
    `- mentions_bot: ${input.event.mentions_bot}`,
    `- source_thread_ref: ${JSON.stringify(input.event.source_thread_ref)}`,
    `- sender: ${input.event.sender.source}:${input.event.sender.id}`,
    `- text: ${input.event.text}`,
    `- attachments: ${input.event.attachments.map((attachment) => attachment.local_path ?? attachment.filename).join(", ") || "(none)"}`,
    "",
    "Now act on the latest thread event.",
  ].join("\n");
}

export function skillSatisfiesPermissions(skill: import("../types.js").SkillRecord, permissions: string[]): boolean {
  return skillMatchesPermission(skill, permissions);
}

export async function collectPermissionEvents(thread: TurnInput["thread"]): Promise<string[]> {
  const files = await fs.readdir(thread.eventsDir).catch(() => []);
  return files
    .filter((file) => file.includes("owner_permission") || file.includes("permission_request"))
    .sort()
    .map((file) => path.join(thread.eventsDir, file));
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
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const after = start + startMarker.length;
  const end = text.indexOf(endMarker, after);
  if (end < 0) return null;
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
  const lines = [
    "You are Felix, replying in a conversation thread.",
    `The owner just ${input.mode === "reject" ? "rejected" : "approved"} a permission request for skill "${input.skillId}".`,
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
