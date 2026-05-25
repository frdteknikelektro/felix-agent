import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { AppConfig } from "./config.js";
import type { ContactRecord, SkillRecord, UniversalEvent } from "./types.js";
import { appendText, ensureDir, readText, writeTextAtomic } from "./lib/fs.js";
import { fsTimestamp } from "./lib/time.js";
import { log } from "./lib/log.js";
import type { ThreadHandle } from "./thread-store.js";
import { skillMatchesPermission } from "./skills.js";

export interface CodexTurnInput {
  thread: ThreadHandle;
  event: UniversalEvent;
  eventFile: string;
  contact: ContactRecord;
  skills: SkillRecord[];
  skillIndexPath: string;
  permissionEvents: string[];
  threadTranscriptPath: string;
  images: string[];
  resumed: boolean;
}

export interface CodexTurnResult {
  sessionId: string;
  exitCode: number;
  lastMessage: string;
  logPath: string;
  turnPath: string;
}

export interface ParsedAgentOutput {
  kind: "reply" | "permission_required" | "no_skill" | "unknown";
  text: string;
  skillId?: string;
  permissions?: string[];
  reason?: string;
  ownerMessage?: string;
}

export interface PermissionRequiredOutput {
  kind: "permission_required";
  text: string;
  skillId?: string;
  permissions: string[];
  reason?: string;
  ownerMessage?: string;
}

export async function runCodexTurn(
  cfg: AppConfig,
  input: CodexTurnInput,
): Promise<CodexTurnResult> {
  await ensureDir(input.thread.codexDir);
  const sessionState = input.thread.session;
  const sessionId = sessionState.codex_session_id ?? crypto.randomUUID();
  const turnPath = path.join(input.thread.codexDir, `${fsTimestamp(new Date())}_${input.resumed ? "resume" : "start"}.md`);
  const outputLastMessagePath = `${turnPath}.last-message.txt`;
  const logPath = `${turnPath}.log`;
  const prompt = buildTurnPrompt(cfg, input, sessionId);
  const baseArgs = [
    "--json",
    "--skip-git-repo-check",
    "--output-last-message",
    outputLastMessagePath,
    ...(cfg.CODEX_BYPASS_SANDBOX ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
    "--model",
    cfg.CODEX_MODEL,
  ];
  const args = [
    "exec",
    ...(input.resumed ? ["resume", ...baseArgs, sessionId, prompt] : [...baseArgs, prompt]),
  ];

  await writeTextAtomic(turnPath, prompt);

  let capturedSessionId = sessionId;
  const child = spawn(cfg.CODEX_BIN, args, {
    cwd: cfg.paths.root,
    env: {
      ...process.env,
      OPENAI_API_KEY: cfg.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: cfg.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
      OPENAI_ORGANIZATION: cfg.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORGANIZATION,
      OPENAI_PROJECT: cfg.OPENAI_PROJECT ?? process.env.OPENAI_PROJECT,
      PATH: buildSpawnPath(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await ensureDir(path.dirname(logPath));
  const logStream = await fs.open(logPath, "a");
  const stderrStream = await fs.open(`${logPath}.stderr`, "a");
  let stdout = "";

  const exitCode = await new Promise<number>((resolve) => {
    child.stdout.on("data", async (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      await appendText(logPath, text);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            capturedSessionId = event.thread_id;
          }
        } catch {
          // keep going
        }
      }
    });
    child.stderr.on("data", async (chunk: Buffer) => {
      await appendText(`${logPath}.stderr`, chunk.toString("utf8"));
    });
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", (error) => {
      log.error("codex.spawn_error", { error: error.message });
      resolve(-1);
    });
  });

  await logStream.close();
  await stderrStream.close();

  const lastMessage = await readText(outputLastMessagePath, "");
  if (capturedSessionId !== sessionState.codex_session_id) {
    input.thread.session.codex_session_id = capturedSessionId;
  }
  return {
    sessionId: capturedSessionId,
    exitCode,
    lastMessage,
    logPath,
    turnPath,
  };
}

export async function ensureCodexAuth(cfg: AppConfig): Promise<void> {
  if (!cfg.OPENAI_API_KEY) {
    return;
  }

  const auth = spawnSync(
    cfg.CODEX_BIN,
    ["login", "--with-api-key"],
    {
      cwd: cfg.paths.root,
      input: `${cfg.OPENAI_API_KEY}\n`,
      env: {
        ...process.env,
        OPENAI_API_KEY: cfg.OPENAI_API_KEY,
        OPENAI_BASE_URL: cfg.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
        OPENAI_ORGANIZATION: cfg.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORGANIZATION,
        OPENAI_PROJECT: cfg.OPENAI_PROJECT ?? process.env.OPENAI_PROJECT,
        PATH: buildSpawnPath(),
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );

  if (auth.status !== 0) {
    const stderr = typeof auth.stderr === "string" ? auth.stderr.trim() : "";
    const stdout = typeof auth.stdout === "string" ? auth.stdout.trim() : "";
    throw new Error(`codex login failed: ${stderr || stdout || `exit ${auth.status ?? -1}`}`);
  }
}

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
      text: perm.raw,
      skillId: perm.skillId,
      permissions: perm.permissions,
      reason: perm.reason,
      ownerMessage: perm.ownerMessage,
    };
  }

  return { kind: "unknown", text };
}

export function hasRenderableOutput(output: ParsedAgentOutput): boolean {
  if (output.kind === "reply") {
    return output.text.trim().length > 0;
  }
  if (output.kind === "permission_required") {
    return output.text.trim().length > 0;
  }
  return output.text.trim().length > 0;
}

export function buildTurnPrompt(
  cfg: AppConfig,
  input: CodexTurnInput,
  sessionId: string,
): string {
  const permanentPermissions = input.contact.allowed_permissions.join(", ") || "(none)";
  const permanentSkills = input.contact.allowed_skills.join(", ") || "(none)";
  const hasGeneralSkill = input.skills.some((skill) => skill.id === "general");
  const skillSummary = input.skills
    .map((skill) => `${skill.id} [${skill.permissions.join(", ") || "no permissions"}]`)
    .join("\n");
  const permissionEvents = input.permissionEvents.length > 0 ? input.permissionEvents.join("\n") : "(none)";
  const availableSkillPaths = input.skills.map((skill) => skill.path).join("\n");
  return [
    "# Felix Session Contract",
    "",
    `Session id: ${sessionId}`,
    `Source: ${input.event.source}`,
    `Thread key: ${input.event.thread_key}`,
    `Thread dir: ${input.thread.dir}`,
    `Transcript: ${input.threadTranscriptPath}`,
    `Requester contact: ${contactFilePath(cfg, input.contact.source, input.contact.user_id)}`,
    `Skill index: ${input.skillIndexPath}`,
    "",
    "You are a persistent agent bound to this one source thread.",
    "Do not use stale memory for skills or permissions.",
    "Before doing anything, reread the current skill index, the relevant SKILL.md files, the requester contact document, and the latest permission events in the thread directory.",
    "The thread transcript and event files are the source of truth for what has already happened.",
    hasGeneralSkill
      ? "The general skill is the default for ordinary conversation, simple informational help, and short explanations. It is reply-only: keep responses short, ask one clarifying question if the request is ambiguous, and defer to a more specialized skill if one fits better. Read workspace/skills/general/SKILL.md before answering those requests."
      : "No general skill is installed. If no specialized skill matches a simple informational request, use the unsupported fallback.",
    "",
    "Behavior contract:",
    "1. Follow only installed skills found in workspace/skills.",
    "2. If no installed skill matches the request, reply exactly: I don't have the skill yet.",
    "3. If a skill matches but permissions are missing, do not execute the work. Request owner permission.",
    "4. If permanent permissions in the contact document do not cover the skill, check thread-scoped owner permission events before asking again.",
    "5. If the thread-scoped owner permission event covers the missing permissions, treat it as valid for this thread only.",
    "6. If permission is still missing, emit PERMISSION_REQUIRED using the exact block format.",
    "7. If permission is satisfied, perform the requested work through the matching skill.",
    "8. Keep user-facing replies concise.",
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
    "Current contact permissions:",
    `- allowed_permissions: ${permanentPermissions}`,
    `- allowed_skills: ${permanentSkills}`,
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
    `- sender: ${input.event.sender.source}:${input.event.sender.id}`,
    `- text: ${input.event.text}`,
    `- attachments: ${input.event.attachments.map((attachment) => attachment.local_path ?? attachment.filename).join(", ") || "(none)"}`,
    "",
    "Now act on the latest thread event.",
  ].join("\n");
}

function extractPermissionBlock(text: string): {
  raw: string;
  skillId?: string;
  permissions: string[];
  reason?: string;
  ownerMessage?: string;
} | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "PERMISSION_REQUIRED");
  if (start < 0) return null;
  const end = lines.findIndex((line, idx) => idx > start && line.trim() === "END_PERMISSION_REQUIRED");
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
    skillId: map.get("skill")?.[0],
    permissions: map.get("permissions") ?? [],
    reason: map.get("reason")?.[0],
    ownerMessage: map.get("owner_message")?.join("\n"),
  };
}

function between(text: string, startMarker: string, endMarker: string): string | null {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const after = start + startMarker.length;
  const end = text.indexOf(endMarker, after);
  if (end < 0) return null;
  return text.slice(after, end);
}

function contactFilePath(cfg: AppConfig, source: string, userId: string): string {
  return path.join(cfg.paths.contacts, source, `${userId.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`);
}

export function skillSatisfiesPermissions(skill: SkillRecord, permissions: string[]): boolean {
  return skillMatchesPermission(skill, permissions);
}

function buildSpawnPath(): string {
  const localBin = path.resolve(process.cwd(), "node_modules", ".bin");
  const current = process.env.PATH ?? "";
  return current.includes(localBin) ? current : `${localBin}:${current}`;
}
