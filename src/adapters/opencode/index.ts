import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { AppConfig } from "../../config.js";
import { appendText, ensureDir, readText, writeTextAtomic } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { Harness, TurnInput, TurnResult, TurnUsage, DecisionNotificationInput, CompactResult } from "../../core/ports.js";
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

export interface OpencodeRunOptions {
  /** Override the spawn function (for testing). */
  spawnFn?: typeof spawn;
}

export async function opencodeRun(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  logPath: string,
  signal?: AbortSignal,
  options?: OpencodeRunOptions,
): Promise<RunResult> {
  await ensureDir(path.dirname(logPath));

  if (signal?.aborted) {
    return { exitCode: 143, sessionId: "", assistantText: "", usage: null };
  }

  const spawnChild = options?.spawnFn ?? spawn;

  const child = spawnChild(bin, args, {
    cwd,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (signal) {
    signal.addEventListener("abort", () => { child.kill("SIGTERM"); }, { once: true });
  }

  const logStream = await fs.open(logPath, "a");

  let buf = "";
  let ebuf = "";

  // Streaming state — updated in real-time as stdout lines arrive.
  let capturedSessionId = "";
  const textParts: string[] = [];
  let lastEventType: string | null = null;
  let usage: TurnUsage | null = null;

  const GRACE_MS = 5_000;
  let graceTimerId: ReturnType<typeof setTimeout> | undefined;

  function escalateToSIGKILL() {
    if (child.killed) return;
    child.kill("SIGKILL");
  }

  const { exitCode, streamError } = await new Promise<{ exitCode: number; streamError: string | null }>((resolve) => {
    let streamError: string | null = null;
    let settled = false;
    let resolveOnce: ((v: { exitCode: number; streamError: string | null }) => void) | null = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    child.stdout.on("data", async (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        // Process each JSON event immediately so terminal errors are caught
        // before the child exits.
        processLine(line);
        if (streamError) {
          if (!child.killed) child.kill("SIGTERM");
          graceTimerId = setTimeout(escalateToSIGKILL, GRACE_MS);
          resolveOnce?.({ exitCode: 1, streamError });
          resolveOnce = null;
          return;
        }
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
      if (buf.trim()) processLine(buf);
      if (graceTimerId !== undefined) clearTimeout(graceTimerId);
      resolveOnce?.({ exitCode: code ?? -1, streamError });
      resolveOnce = null;
    });

    child.on("error", (error) => {
      log.error("opencode.spawn_error", { error: error.message });
      resolveOnce?.({ exitCode: -1, streamError: error.message });
      resolveOnce = null;
    });

    function processLine(line: string) {
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
          if (msg && !streamError) streamError = msg;
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
        // not JSON — ignore
      }
    }
  });

  await logStream.close();

  if (streamError) {
    throw new Error(streamError);
  }

  return { exitCode, sessionId: capturedSessionId, assistantText: textParts.join(""), usage };
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
    const model = input.modelOverride ?? settings.model;

    await writeTextAtomic(turnPath, prompt);

    const baseArgs = [
      "run",
      "--dir", this.cfg.paths.root,
      "--model", model,
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
    const usageWithModel = usage ? { ...usage, model: usage.model ?? model } : null;

    return { sessionId: capturedSessionId || sessionId, exitCode, success, parsed, logPath, usage: usageWithModel };
  }

  async generateDecisionNotification(input: DecisionNotificationInput): Promise<string> {
    await ensureDir(input.thread.turnsDir);
    const baseName = `${fsTimestamp(new Date())}_decision_notification`;
    const promptPath = path.join(input.thread.turnsDir, `${baseName}.md`);
    const logPath = path.join(input.thread.turnsDir, `${baseName}.log`);

    const prompt = buildDecisionNotificationPrompt({ ...input, agentName: this.cfg.FELIX_NAME });
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

  async compact(sessionId: string, threadDir?: string): Promise<CompactResult> {
    const logPath = path.join(this.cfg.paths.root, `compact_${sessionId}.log`);
    const summaryPath = path.join(this.cfg.paths.root, `compact_${sessionId}.txt`);
    const summarizationPrompt = [
      "Summarize this conversation for context continuity. Include:",
      "1. The overall goal or objective being worked toward",
      "2. Progress made so far (what's been completed, what's in flight)",
      "3. The most recent request or question and its current status",
      "4. Key decisions, constraints, or facts the next session must know",
      "5. Any pending items or open questions",
      "",
      "Be concise but preserve specifics (file paths, function names, error messages).",
    ].join("\n");

    const args = [
      "exec",
      "--json",
      "--output-last-message", summaryPath,
      "--session", sessionId,
      summarizationPrompt,
    ];

    try {
      const { exitCode, sessionId: capturedSessionId } = await opencodeRun(
        this.cfg.OPENCODE_BIN,
        args,
        this.cfg.paths.root,
        await this.buildEnv(),
        logPath,
      );

      if (exitCode !== 0) {
        log.warn("opencode.compact_failed", { session_id: sessionId, exit_code: exitCode });
        await fs.unlink(logPath).catch(() => {});
        await fs.unlink(summaryPath).catch(() => {});
        return { success: false };
      }

      // Read the summary from the output file
      const rawSummary = await readText(summaryPath, "");
      // Strip FELIX_REPLY markers if present
      const summary = between(rawSummary, "FELIX_REPLY", "END_FELIX_REPLY")?.trim() || rawSummary.trim();

      // Clean up compact files
      await fs.unlink(logPath).catch(() => {});
      await fs.unlink(summaryPath).catch(() => {});

      if (!summary) {
        log.warn("opencode.compact_empty_summary", { session_id: sessionId });
        return { success: false };
      }

      // Append summary to INITIAL.md
      if (threadDir) {
        await appendCompactedContext(threadDir, summary);
      }

      return { success: true, sessionId: capturedSessionId || undefined };
    } catch (error) {
      log.warn("opencode.compact_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false };
    }
  }
}

export async function ensureOpencodeAuth(cfg: AppConfig): Promise<void> {
  const check = spawnSync(cfg.OPENCODE_BIN, ["--version"], {
    cwd: cfg.paths.root,
    env: { ...process.env } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });

  if (check.status !== 0) {
    const stderr = typeof check.stderr === "string" ? check.stderr.trim() : "";
    const stdout = typeof check.stdout === "string" ? check.stdout.trim() : "";
    throw new Error(`opencode binary check failed: ${stderr || stdout || `exit ${check.status ?? -1}`}`);
  }
}
