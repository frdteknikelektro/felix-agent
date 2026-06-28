import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { AppConfig } from "../../config.js";
import { appendText, ensureDir, readText, writeTextAtomic } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { Harness, TurnInput, TurnResult, TurnUsage, DecisionNotificationInput } from "../../core/ports.js";
import {
  parseAgentOutput,
  hasRenderableOutput,
  buildTurnPrompt,
  buildDecisionNotificationPrompt,
  between,
  fallbackNotification,
  normalizeUsage,
} from "../../core/harness-common.js";
import { appendCompactedContext } from "../../core/initial-md.js";
import { opencodeSettings } from "../../core/harness-settings.js";
export type { ParsedAgentOutput, PermissionRequiredOutput } from "../../core/ports.js";

// ─── Shared spawn ─────────────────────────────────────────────────────────

function extractError(event: Record<string, unknown>): string | null {
  const message = typeof event.message === "string" ? event.message : null;
  const error = event.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const inner = (error as Record<string, unknown>).message;
    if (typeof inner === "string") return inner;
  }
  return message;
}

export interface RunResult {
  exitCode: number;
  sessionId: string;
  assistantText: string;
  usage: TurnUsage | null;
}

export async function opencodeRun(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  logPath: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  await ensureDir(path.dirname(logPath));

  if (signal?.aborted) {
    return { exitCode: 143, sessionId: "", assistantText: "", usage: null };
  }

  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (signal) {
    signal.addEventListener("abort", () => { child.kill("SIGTERM"); }, { once: true });
  }

  const logStream = await fs.open(logPath, "a");

  const stdoutLines: string[] = [];
  let buf = "";
  let ebuf = "";

  const exitCode = await new Promise<number>((resolve) => {
    child.stdout.on("data", async (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line) stdoutLines.push(line);
      }
      await appendText(logPath, chunk.toString("utf8"));
    });
    child.stderr.on("data", async (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      ebuf += text;
      ebuf = ebuf.split(/\r?\n/).pop() ?? "";
      await appendText(`${logPath}.stderr`, text);
    });
    child.on("close", (code) => {
      if (buf.trim()) stdoutLines.push(buf);
      resolve(code ?? -1);
    });
    child.on("error", (error) => {
      log.error("opencode.spawn_error", { error: error.message });
      resolve(-1);
    });
  });

  await logStream.close();

  let capturedSessionId = "";
  const textParts: string[] = [];
  let lastEventType: string | null = null;
  const errors: string[] = [];
  let usage: TurnUsage | null = null;

  // opencode v1.17.x `--format json` emits token usage on step_finish events
  // under part.tokens (input, output, cache.read, cache.write).  modelID is not
  // in the stream — the harness falls back to cfg.OPENCODE_MODEL.

  for (const line of stdoutLines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const eventType = typeof event.type === "string" ? event.type : null;
      if (eventType === "step_start" && typeof event.sessionID === "string" && !capturedSessionId) {
        capturedSessionId = event.sessionID;
      }
      if (eventType === "step_finish") {
        const part = event.part as Record<string, unknown> | undefined;
        const tokens = part?.tokens as Record<string, unknown> | undefined;
        if (tokens && typeof tokens === "object") {
          const cache = tokens.cache as Record<string, unknown> | undefined;
          const normalized = normalizeUsage({
            input: tokens.input,
            output: tokens.output,
            cache_read: cache?.read,
            cache_write: cache?.write,
          });
          if (normalized) usage = normalized;
        }
      }
      if (eventType === "error") {
        const msg = extractError(event);
        if (msg) errors.push(msg);
        continue;
      }
      if (eventType === "text" && typeof event.part === "object" && event.part !== null) {
        const part = event.part as Record<string, unknown>;
        if (part.type === "text" && typeof part.text === "string") {
          if (lastEventType !== null && lastEventType !== "text") {
            textParts.push("\n\n");
          }
          textParts.push(part.text);
        }
      }
      if (eventType === "tool" && typeof event.part === "object" && event.part !== null) {
        const part = event.part as Record<string, unknown>;
        if (part.type === "tool_use" && typeof part.name === "string") {
          if (lastEventType !== null && lastEventType !== "tool") {
            textParts.push("\n\n");
          }
          textParts.push("Tool: " + part.name);
        } else if (part.type === "tool_result" && part.result !== undefined && part.result !== null) {
          textParts.push("\n\n" + String(part.result));
        }
      }
      if (eventType) lastEventType = eventType;
    } catch {
    }
  }

  const assistantText = textParts.join("");

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return { exitCode, sessionId: capturedSessionId, assistantText, usage };
}

// ─── Harness ──────────────────────────────────────────────────────────────

export class OpencodeHarness implements Harness {
  constructor(private readonly cfg: AppConfig) {}

  private buildEnv(): Record<string, string | undefined> {
    return opencodeSettings(this.cfg).env;
  }

  async run(input: TurnInput): Promise<TurnResult> {
    await ensureDir(input.thread.turnsDir);
    const sessionState = input.thread.session;
    const hasSession = Boolean(sessionState.harness_session_id);
    const sessionId = sessionState.harness_session_id ?? crypto.randomUUID();
    const turnPath = path.join(
      input.thread.turnsDir,
      `${fsTimestamp(new Date())}_${input.resumed ? "resume" : "start"}.md`,
    );
    const logPath = `${turnPath}.log`;
    const prompt = input.promptOverride ?? await buildTurnPrompt(this.cfg, input, sessionId);
    const settings = opencodeSettings(this.cfg);

    await writeTextAtomic(turnPath, prompt);

    const baseArgs = [
      "run",
      "--dir", this.cfg.paths.root,
      "--model", settings.model,
      "--title", input.thread.state.thread_key,
      "--format", "json",
      "--dangerously-skip-permissions",
    ];
    if (this.cfg.OPENCODE_VARIANT) {
      baseArgs.push("--variant", this.cfg.OPENCODE_VARIANT);
    }

    const args = hasSession
      ? [...baseArgs, "--session", sessionId, prompt]
      : [...baseArgs, prompt];

    const { exitCode, sessionId: capturedSessionId, assistantText, usage } =
      await opencodeRun(this.cfg.OPENCODE_BIN, args, this.cfg.paths.root, await this.buildEnv(), logPath, input.signal);

    if (capturedSessionId && capturedSessionId !== sessionState.harness_session_id) {
      input.thread.session.harness_session_id = capturedSessionId;
    }

    const parsed = parseAgentOutput(assistantText);
    const success = exitCode === 0 && hasRenderableOutput(parsed);
    const usageWithModel = usage ? { ...usage, model: usage.model ?? settings.model } : null;

    return { sessionId: capturedSessionId || sessionId, exitCode, success, parsed, logPath, usage: usageWithModel };
  }

  async generateDecisionNotification(input: DecisionNotificationInput): Promise<string> {
    await ensureDir(input.thread.turnsDir);
    const baseName = `${fsTimestamp(new Date())}_decision_notification`;
    const promptPath = path.join(input.thread.turnsDir, `${baseName}.md`);
    const logPath = path.join(input.thread.turnsDir, `${baseName}.log`);

    const prompt = buildDecisionNotificationPrompt(input);
    await writeTextAtomic(promptPath, prompt);
    const settings = opencodeSettings(this.cfg);

    const args = [
      "run",
      "--dir", this.cfg.paths.root,
      "--model", settings.model,
      "--title", `decision-notification-${Date.now()}`,
      "--format", "json",
      "--dangerously-skip-permissions",
      prompt,
    ];

    try {
      const { assistantText } = await opencodeRun(
        this.cfg.OPENCODE_BIN,
        args,
        this.cfg.paths.root,
        await this.buildEnv(),
        logPath,
      );
      const reply = between(assistantText, "FELIX_REPLY", "END_FELIX_REPLY");
      return reply?.trim() || fallbackNotification(input.mode);
    } catch (error) {
      log.warn("opencode.decision_notification_failed", {
        thread_key: input.thread.state.thread_key,
        mode: input.mode,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackNotification(input.mode);
    }
  }

  async compact(sessionId: string, threadDir?: string): Promise<boolean> {
    const logPath = path.join(this.cfg.paths.root, `compact_${sessionId}.log`);
    const summarizationPrompt = [
      "Please summarize our conversation so far.",
      "Focus on:",
      "- Key decisions made",
      "- Important context and facts",
      "- Current task status",
      "- Any pending items",
      "",
      "Provide a concise summary that can be used as context for continuing the conversation.",
    ].join("\n");

    const args = [
      "exec",
      "--json",
      "--output-last-message", path.join(this.cfg.paths.root, `compact_${sessionId}.txt`),
      "--session", sessionId,
      summarizationPrompt,
    ];

    try {
      const { exitCode } = await opencodeRun(
        this.cfg.OPENCODE_BIN,
        args,
        this.cfg.paths.root,
        await this.buildEnv(),
        logPath,
      );

      if (exitCode !== 0) {
        log.warn("opencode.compact_failed", { session_id: sessionId, exit_code: exitCode });
        return false;
      }

      // Read the summary from the output file
      const summaryPath = path.join(this.cfg.paths.root, `compact_${sessionId}.txt`);
      const rawSummary = await readText(summaryPath, "");
      // Strip FELIX_REPLY markers if present
      const summary = between(rawSummary, "FELIX_REPLY", "END_FELIX_REPLY")?.trim() || rawSummary.trim();
      if (!summary) {
        log.warn("opencode.compact_empty_summary", { session_id: sessionId });
        return false;
      }

      // Append summary to INITIAL.md
      if (threadDir) {
        await appendCompactedContext(threadDir, summary);
      }

      return true;
    } catch (error) {
      log.warn("opencode.compact_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

export async function ensureOpencodeAuth(cfg: AppConfig): Promise<void> {
  const check = spawnSync(cfg.OPENCODE_BIN, ["--version"], {
    cwd: cfg.paths.root,
    env: { ...process.env } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (check.status !== 0) {
    const stderr = typeof check.stderr === "string" ? check.stderr.trim() : "";
    const stdout = typeof check.stdout === "string" ? check.stdout.trim() : "";
    throw new Error(`opencode binary check failed: ${stderr || stdout || `exit ${check.status ?? -1}`}`);
  }
}
