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
import { claudeCodeSettings } from "../../core/harness-settings.js";
export type { ParsedAgentOutput, PermissionRequiredOutput } from "../../core/ports.js";

// ─── Shared spawn ─────────────────────────────────────────────────────────

export interface RunResult {
  exitCode: number;
  sessionId: string;
  assistantText: string;
  usage: TurnUsage | null;
}

export async function claudeCodeRun(
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
      log.error("claude-code.spawn_error", { error: error.message });
      resolve(-1);
    });
  });

  await logStream.close();

  const { sessionId, assistantText, usage } = parseClaudeStdout(stdoutLines);

  if (exitCode === 0 && !assistantText) {
    const lastLine = stdoutLines[stdoutLines.length - 1] ?? "";
    log.warn("claude-code.empty_after_parse", {
      lines: stdoutLines.length,
      snippet: lastLine.slice(0, 200),
    });
  }

  return { exitCode, sessionId, assistantText, usage };
}

// ─── Output parser ────────────────────────────────────────────────────────

export interface ParsedClaudeStdout {
  sessionId: string;
  assistantText: string;
  usage: TurnUsage | null;
}

/**
 * Parse the stdout lines of a `claude -p --output-format json` (or stream-json) run.
 *
 * The non-streaming `json` mode emits a SINGLE JSON object whose shape (verified
 * against claude 2.1.161) is:
 *   { "type":"result", "subtype":"success", "result":"<reply text>",
 *     "session_id":"<uuid>", "usage":{ input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens, ... }, "modelUsage":{...} }
 * i.e. `result` is a top-level STRING and `session_id`/`usage` are top-level — there is
 * no `system`/`init` or `assistant` event. The older nested `result.result` form and the
 * stream-json `assistant`/`system` events are still handled defensively for compatibility.
 */
export function parseClaudeStdout(stdoutLines: string[]): ParsedClaudeStdout {
  let capturedSessionId = "";
  const textParts: string[] = [];
  let usageRaw: Record<string, unknown> | null = null;
  let model: string | null = null;

  for (const line of stdoutLines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // Not valid JSON, skip
    }
    const eventType = typeof event.type === "string" ? event.type : null;
    const eventSubtype = typeof event.subtype === "string" ? event.subtype : null;

    // Top-level session_id (json mode) — also seen on stream-json system/init.
    if (typeof event.session_id === "string") {
      capturedSessionId = event.session_id;
    }

    // stream-json: session id may instead live under the init event's data.
    if (eventType === "system" && eventSubtype === "init") {
      const data = event.data as Record<string, unknown> | undefined;
      if (data && typeof data.session_id === "string") {
        capturedSessionId = data.session_id;
      }
    }

    // stream-json: assistant text + model arrive on assistant message events.
    if (eventType === "assistant") {
      const message = event.message as Record<string, unknown> | undefined;
      if (message && typeof message.model === "string") {
        model = message.model;
      }
      if (message && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (typeof block === "object" && block !== null) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              textParts.push(b.text);
            }
          }
        }
      }
    }

    // Final result event: reply text + cumulative usage.
    if (eventType === "result") {
      // json mode: top-level string. Older/nested form: result.result.
      if (typeof event.result === "string") {
        textParts.push(event.result);
      } else {
        const nested = event.result as Record<string, unknown> | undefined;
        if (nested && typeof nested.result === "string") {
          textParts.push(nested.result);
        }
      }
      if (event.usage && typeof event.usage === "object") {
        usageRaw = event.usage as Record<string, unknown>;
      }
      // json mode exposes the model under modelUsage keyed by model id.
      if (!model && event.modelUsage && typeof event.modelUsage === "object") {
        const keys = Object.keys(event.modelUsage as Record<string, unknown>);
        if (keys.length > 0) model = keys[0];
      }
    }
  }

  const assistantText = textParts.join("");
  const usage = usageRaw
    ? normalizeUsage({
        input: usageRaw.input_tokens,
        output: usageRaw.output_tokens,
        cache_read: usageRaw.cache_read_input_tokens,
        cache_write: usageRaw.cache_creation_input_tokens,
        model,
      })
    : null;

  return { sessionId: capturedSessionId, assistantText, usage };
}

// ─── Arg builder ──────────────────────────────────────────────────────────

export interface ClaudeTurnArgs {
  model: string;
  workspaceDir: string;
  sessionId: string;
  hasSession: boolean;
  prompt: string;
}

/**
 * Build the claude CLI argv for a turn.
 *
 * The prompt MUST come before `--add-dir`: the Claude Code CLI treats a value
 * sitting immediately after `--add-dir` as the directory, so a trailing
 * `--add-dir <dir> <prompt>` swallows the prompt and the CLI aborts with
 * "Input must be provided either through stdin or as a prompt argument".
 * Keep `--add-dir` last, after the positional prompt.
 */
export function buildClaudeTurnArgs(opts: ClaudeTurnArgs): string[] {
  const baseArgs = [
    "-p",
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--model", opts.model,
  ];
  const sessionArgs = opts.hasSession
    ? ["--resume", opts.sessionId]
    : ["--session-id", opts.sessionId];
  return [...baseArgs, ...sessionArgs, opts.prompt, "--add-dir", opts.workspaceDir];
}

// ─── Harness ──────────────────────────────────────────────────────────────

export class ClaudeCodeHarness implements Harness {
  constructor(private readonly cfg: AppConfig) {}

  private buildEnv(): Record<string, string | undefined> {
    return claudeCodeSettings(this.cfg).env;
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
    const settings = claudeCodeSettings(this.cfg);

    await writeTextAtomic(turnPath, prompt);

    const args = buildClaudeTurnArgs({
      model: settings.model,
      workspaceDir: this.cfg.WORKSPACE_DIR,
      sessionId,
      hasSession,
      prompt,
    });

    const { exitCode, sessionId: capturedSessionId, assistantText, usage } =
      await claudeCodeRun(this.cfg.CLAUDE_CODE_BIN, args, this.cfg.paths.root, this.buildEnv(), logPath, input.signal);

    if (capturedSessionId && capturedSessionId !== sessionState.harness_session_id) {
      input.thread.session.harness_session_id = capturedSessionId;
    }

    const parsed = parseAgentOutput(assistantText);
    const success = exitCode === 0 && hasRenderableOutput(parsed);

    return { sessionId: capturedSessionId || sessionId, exitCode, success, parsed, logPath, usage };
  }

  async generateDecisionNotification(input: DecisionNotificationInput): Promise<string> {
    await ensureDir(input.thread.turnsDir);
    const baseName = `${fsTimestamp(new Date())}_decision_notification`;
    const promptPath = path.join(input.thread.turnsDir, `${baseName}.md`);
    const logPath = path.join(input.thread.turnsDir, `${baseName}.log`);

    const prompt = buildDecisionNotificationPrompt(input);
    await writeTextAtomic(promptPath, prompt);
    const settings = claudeCodeSettings(this.cfg);

    const args = [
      "-p",
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--model", settings.model,
      prompt,
    ];

    try {
      const { assistantText } = await claudeCodeRun(
        this.cfg.CLAUDE_CODE_BIN,
        args,
        this.cfg.paths.root,
        this.buildEnv(),
        logPath,
      );
      const reply = between(assistantText, "FELIX_REPLY", "END_FELIX_REPLY");
      return reply?.trim() || fallbackNotification(input.mode);
    } catch (error) {
      log.warn("claude-code.decision_notification_failed", {
        thread_key: input.thread.state.thread_key,
        mode: input.mode,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackNotification(input.mode);
    }
  }

  async compact(sessionId: string, threadDir?: string): Promise<CompactResult> {
    const logPath = path.join(this.cfg.paths.root, `compact_claude_${sessionId}.log`);
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
    const settings = claudeCodeSettings(this.cfg);

    const args = [
      "--resume", sessionId,
      "-p",
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--model", settings.model,
      summarizationPrompt,
    ];

    try {
      const { sessionId: capturedSessionId, assistantText } = await claudeCodeRun(
        this.cfg.CLAUDE_CODE_BIN,
        args,
        this.cfg.paths.root,
        this.buildEnv(),
        logPath,
      );

      // Strip FELIX_REPLY markers if present
      const summary = between(assistantText, "FELIX_REPLY", "END_FELIX_REPLY")?.trim() || assistantText.trim();

      // Clean up compact files
      await fs.unlink(logPath).catch(() => {});
      await fs.unlink(`${logPath}.stderr`).catch(() => {});

      if (!summary) {
        log.warn("claude-code.compact_empty_summary", { session_id: sessionId });
        return { success: false };
      }

      // Append summary to INITIAL.md
      if (threadDir) {
        await appendCompactedContext(threadDir, summary);
      }

      return { success: true, sessionId: capturedSessionId || undefined };
    } catch (error) {
      log.warn("claude-code.compact_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false };
    }
  }
}

export async function ensureClaudeCodeAuth(cfg: AppConfig): Promise<void> {
  const settings = claudeCodeSettings(cfg);
  const check = spawnSync(cfg.CLAUDE_CODE_BIN, ["--version"], {
    cwd: cfg.paths.root,
    env: {
      ...process.env,
      ...settings.env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  if (check.status !== 0) {
    const stderr = typeof check.stderr === "string" ? check.stderr.trim() : "";
    const stdout = typeof check.stdout === "string" ? check.stdout.trim() : "";
    throw new Error(`claude-code binary check failed: ${stderr || stdout || `exit ${check.status ?? -1}`}`);
  }
}
