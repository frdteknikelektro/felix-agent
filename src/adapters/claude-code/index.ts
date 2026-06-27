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
  buildSpawnPath,
  normalizeUsage,
} from "../../core/harness-common.js";
import { appendCompactedContext } from "../../core/initial-md.js";
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

  let capturedSessionId = "";
  const textParts: string[] = [];
  let usageRaw: Record<string, unknown> | null = null;
  let model: string | null = null;

  for (const line of stdoutLines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const eventType = typeof event.type === "string" ? event.type : null;
      const eventSubtype = typeof event.subtype === "string" ? event.subtype : null;

      // Capture session ID from system init message
      if (eventType === "system" && eventSubtype === "init") {
        const data = event.data as Record<string, unknown> | undefined;
        if (data && typeof data.session_id === "string") {
          capturedSessionId = data.session_id;
        }
      }

      // Capture assistant text from assistant messages
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

      // Capture final result + its cumulative usage
      if (eventType === "result") {
        const result = event.result as Record<string, unknown> | undefined;
        if (result && typeof result.result === "string") {
          textParts.push(result.result);
        }
        if (event.usage && typeof event.usage === "object") {
          usageRaw = event.usage as Record<string, unknown>;
        }
      }
    } catch {
      // Not valid JSON, skip
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

  return { exitCode, sessionId: capturedSessionId, assistantText, usage };
}

// ─── Harness ──────────────────────────────────────────────────────────────

export class ClaudeCodeHarness implements Harness {
  constructor(private readonly cfg: AppConfig) {}

  private buildEnv(): Record<string, string | undefined> {
    return {
      WORKSPACE_DIR: this.cfg.WORKSPACE_DIR,
      ANTHROPIC_API_KEY: this.cfg.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      PATH: buildSpawnPath(this.cfg),
    };
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

    await writeTextAtomic(turnPath, prompt);

    const baseArgs = [
      "-p",
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--model", this.cfg.CLAUDE_CODE_MODEL,
      "--add-dir", this.cfg.WORKSPACE_DIR,
    ];

    const args = hasSession
      ? [...baseArgs, "--resume", sessionId, prompt]
      : [...baseArgs, "--session-id", sessionId, prompt];

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

    const args = [
      "-p",
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--model", this.cfg.CLAUDE_CODE_MODEL,
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

  async compact(sessionId: string, threadDir?: string): Promise<boolean> {
    const logPath = path.join(this.cfg.paths.root, `compact_claude_${sessionId}.log`);
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
      "-p",
      "--dangerously-skip-permissions",
      "--model", this.cfg.CLAUDE_CODE_MODEL,
      summarizationPrompt,
    ];

    try {
      const { assistantText } = await claudeCodeRun(
        this.cfg.CLAUDE_CODE_BIN,
        args,
        this.cfg.paths.root,
        this.buildEnv(),
        logPath,
      );

      const summary = assistantText.trim();
      if (!summary) {
        log.warn("claude-code.compact_empty_summary", { session_id: sessionId });
        return false;
      }

      // Append summary to INITIAL.md
      if (threadDir) {
        await appendCompactedContext(threadDir, summary);
      }

      return true;
    } catch (error) {
      log.warn("claude-code.compact_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

export async function ensureClaudeCodeAuth(cfg: AppConfig): Promise<void> {
  const check = spawnSync(cfg.CLAUDE_CODE_BIN, ["--version"], {
    cwd: cfg.paths.root,
    env: {
      ...process.env,
      WORKSPACE_DIR: cfg.WORKSPACE_DIR,
      ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      PATH: buildSpawnPath(cfg),
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
