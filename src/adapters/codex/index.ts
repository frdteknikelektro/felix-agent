import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
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
import { codexSettings, hasCodexAuth, ninerouterEnabled } from "../../core/harness-settings.js";
export type { ParsedAgentOutput, PermissionRequiredOutput } from "../../core/ports.js";

export const codexAuthForTest = {
  spawnSync,
};

export class CodexHarness implements Harness {
  constructor(private readonly cfg: AppConfig) {}

  async run(input: TurnInput): Promise<TurnResult> {
    await ensureDir(input.thread.turnsDir);
    const sessionState = input.thread.session;
    const sessionId = sessionState.harness_session_id ?? crypto.randomUUID();
    const turnPath = path.join(
      input.thread.turnsDir,
      `${fsTimestamp(new Date())}_${input.resumed ? "resume" : "start"}.md`,
    );
    const outputLastMessagePath = `${turnPath}.last-message.txt`;
    const logPath = `${turnPath}.log`;
    const prompt = input.promptOverride ?? await buildTurnPrompt(this.cfg, input, sessionId);
    const settings = codexSettings(this.cfg);
    const baseArgs = [
      "--json",
      "--skip-git-repo-check",
      "--output-last-message",
      outputLastMessagePath,
      ...(this.cfg.CODEX_BYPASS_SANDBOX ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      "-c",
      `reasoning_effort="${this.cfg.CODEX_REASONING_EFFORT}"`,
      "--model",
      settings.model,
    ];
    const args = [
      "exec",
      ...(input.resumed ? ["resume", ...baseArgs, sessionId, prompt] : [...baseArgs, prompt]),
    ];

    await writeTextAtomic(turnPath, prompt);

    if (input.signal?.aborted) {
      return { sessionId, exitCode: 143, success: false, parsed: parseAgentOutput("Stopped."), logPath };
    }

    let capturedSessionId = sessionId;
    let capturedUsage: TurnUsage | null = null;
    let capturedCumulative = false;
    const child = spawn(this.cfg.CODEX_BIN, args, {
      cwd: this.cfg.paths.root,
      env: {
        ...process.env,
        ...settings.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (input.signal) {
      input.signal.addEventListener("abort", () => { child.kill("SIGTERM"); }, { once: true });
    }
    await ensureDir(path.dirname(logPath));
    const logStream = await fs.open(logPath, "a");

    let ebuf = "";

    const exitCode = await new Promise<number>((resolve) => {
      child.stdout.on("data", async (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        await appendText(logPath, text);
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            if (event.type === "thread.started" && typeof event.thread_id === "string") {
              capturedSessionId = event.thread_id;
            }
            // Codex emits a usage object on turn-completion events. Field names
            // and per-turn-vs-cumulative semantics drift across versions, so take
            // the last one we see and track whether it was session-cumulative.
            const found = extractCodexUsage(event);
            if (found) {
              const normalized = normalizeUsage({
                input: found.raw.input_tokens,
                output: found.raw.output_tokens,
                cache_read: found.raw.cached_input_tokens,
                model: this.cfg.CODEX_MODEL,
              });
              if (normalized) {
                capturedUsage = normalized;
                capturedCumulative = found.cumulative;
              }
            }
          } catch {
            // keep going
          }
        }
      });
      child.stderr.on("data", async (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        ebuf += text;
        ebuf = ebuf.split(/\r?\n/).pop() ?? "";
        await appendText(`${logPath}.stderr`, text);
      });
      child.on("close", (code) => {
        resolve(code ?? -1);
      });
      child.on("error", (error) => {
        log.error("codex.spawn_error", { error: error.message });
        resolve(-1);
      });
    });

    await logStream.close();

    const lastMessage = await readText(outputLastMessagePath, "");
    if (capturedSessionId !== sessionState.harness_session_id) {
      input.thread.session.harness_session_id = capturedSessionId;
    }

    const parsed = parseAgentOutput(lastMessage);
    const success = exitCode === 0 && hasRenderableOutput(parsed);

    return { sessionId: capturedSessionId, exitCode, success, parsed, logPath, usage: capturedUsage, usageCumulative: capturedCumulative };
  }

  async generateDecisionNotification(input: DecisionNotificationInput): Promise<string> {
    await ensureDir(input.thread.turnsDir);
    const baseName = `${fsTimestamp(new Date())}_decision_notification`;
    const promptPath = path.join(input.thread.turnsDir, `${baseName}.md`);
    const lastMessagePath = path.join(input.thread.turnsDir, `${baseName}.last-message.txt`);

    const prompt = buildDecisionNotificationPrompt(input);
    await writeTextAtomic(promptPath, prompt);
    const settings = codexSettings(this.cfg);

    const args = [
      "exec",
      "-c",
      `reasoning_effort="low"`,
      "--json",
      "--output-last-message",
      lastMessagePath,
      "--model",
      settings.model,
      ...(this.cfg.CODEX_BYPASS_SANDBOX ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      prompt,
    ];

    try {
      spawnSync(this.cfg.CODEX_BIN, args, {
        cwd: this.cfg.paths.root,
        env: {
          ...process.env,
          ...settings.env,
        },
        timeout: 60_000,
        encoding: "utf8",
      });

      const lastMessage = await readText(lastMessagePath, "");
      const reply = between(lastMessage, "FELIX_REPLY", "END_FELIX_REPLY");
      return reply?.trim() || fallbackNotification(input.mode);
    } catch (error) {
      log.warn("codex.decision_notification_failed", {
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
    const settings = codexSettings(this.cfg);

    const args = [
      sessionId,
      summarizationPrompt,
      "--json",
      "--output-last-message", path.join(this.cfg.paths.root, `compact_${sessionId}.txt`),
      ...(this.cfg.CODEX_BYPASS_SANDBOX ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      "-c",
      `reasoning_effort="${this.cfg.CODEX_REASONING_EFFORT}"`,
      "--model",
      settings.model,
    ];

    try {
      const child = spawn(this.cfg.CODEX_BIN, ["resume", ...args], {
        cwd: this.cfg.paths.root,
        env: {
          ...process.env,
          ...settings.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      await ensureDir(path.dirname(logPath));
      const logStream = await fs.open(logPath, "a");

      const exitCode = await new Promise<number>((resolve) => {
        child.stdout.on("data", async (chunk: Buffer) => {
          await appendText(logPath, chunk.toString("utf8"));
        });
        child.stderr.on("data", async (chunk: Buffer) => {
          await appendText(`${logPath}.stderr`, chunk.toString("utf8"));
        });
        child.on("close", (code) => resolve(code ?? -1));
        child.on("error", (error) => {
          log.error("codex.compact_spawn_error", { error: error.message });
          resolve(-1);
        });
      });

      await logStream.close();

      if (exitCode !== 0) {
        log.warn("codex.compact_failed", { session_id: sessionId, exit_code: exitCode });
        return false;
      }

      // Read the summary from the output file
      const summaryPath = path.join(this.cfg.paths.root, `compact_${sessionId}.txt`);
      const rawSummary = await readText(summaryPath, "");
      // Strip FELIX_REPLY markers if present
      const summary = between(rawSummary, "FELIX_REPLY", "END_FELIX_REPLY")?.trim() || rawSummary.trim();
      if (!summary) {
        log.warn("codex.compact_empty_summary", { session_id: sessionId });
        return false;
      }

      // Append summary to INITIAL.md
      if (threadDir) {
        await appendCompactedContext(threadDir, summary);
      }

      return true;
    } catch (error) {
      log.warn("codex.compact_failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

/**
 * Pull a token-usage object out of a codex JSON event, tolerating the field
 * locations seen across codex versions. Returns the raw usage object plus whether
 * it is session-cumulative (`info.total_token_usage`) vs per-turn (`event.usage` /
 * `turn.completed.usage`). The engine deltas cumulative values before recording.
 */
function extractCodexUsage(
  event: Record<string, unknown>,
): { raw: Record<string, unknown>; cumulative: boolean } | null {
  const type = typeof event.type === "string" ? event.type : "";
  const info = event.info as Record<string, unknown> | undefined;
  // Per-turn usage on a completion event is preferred — no delta needed.
  const perTurn =
    (event.usage as Record<string, unknown> | undefined) ??
    (event.turn as Record<string, unknown> | undefined)?.usage;
  if (
    (type === "turn.completed" || type === "token_count" || type.endsWith(".completed")) &&
    perTurn &&
    typeof perTurn === "object"
  ) {
    return { raw: perTurn as Record<string, unknown>, cumulative: false };
  }
  // Otherwise fall back to the session-cumulative total (token_count events).
  const cumulative = info?.total_token_usage;
  if (cumulative && typeof cumulative === "object") {
    return { raw: cumulative as Record<string, unknown>, cumulative: true };
  }
  // Last resort: any event directly carrying a usage object (treat as per-turn).
  if (event.usage && typeof event.usage === "object") {
    return { raw: event.usage as Record<string, unknown>, cumulative: false };
  }
  return null;
}

export async function ensureCodexAuth(cfg: AppConfig): Promise<void> {
  if (ninerouterEnabled(cfg)) {
    return;
  }

  // OAuth: auth.json already written at startup, skip API key login
  if (cfg.OPENAI_CODEX_AUTH_JSON) {
    return;
  }

  if (!hasCodexAuth(cfg)) {
    return;
  }

  const settings = codexSettings(cfg);
  const auth = codexAuthForTest.spawnSync(cfg.CODEX_BIN, ["login", "--with-api-key"], {
    cwd: cfg.paths.root,
    input: `${settings.env.OPENAI_API_KEY ?? ""}\n`,
    env: {
      ...process.env,
      ...settings.env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });

  if (auth.status !== 0) {
    const stderr = typeof auth.stderr === "string" ? auth.stderr.trim() : "";
    const stdout = typeof auth.stdout === "string" ? auth.stdout.trim() : "";
    throw new Error(`codex login failed: ${stderr || stdout || `exit ${auth.status ?? -1}`}`);
  }
}
