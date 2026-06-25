import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { AppConfig } from "../../config.js";
import { appendText, ensureDir, readText, writeTextAtomic } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { Harness, TurnInput, TurnResult, DecisionNotificationInput } from "../../core/ports.js";
import {
  parseAgentOutput,
  hasRenderableOutput,
  buildTurnPrompt,
  buildDecisionNotificationPrompt,
  between,
  fallbackNotification,
  buildSpawnPath,
} from "../../core/harness-common.js";
export type { ParsedAgentOutput, PermissionRequiredOutput } from "../../core/ports.js";

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
    const baseArgs = [
      "--json",
      "--skip-git-repo-check",
      "--output-last-message",
      outputLastMessagePath,
      ...(this.cfg.CODEX_BYPASS_SANDBOX ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      "-c",
      `reasoning_effort="${this.cfg.CODEX_REASONING_EFFORT}"`,
      "--model",
      this.cfg.CODEX_MODEL,
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
    const child = spawn(this.cfg.CODEX_BIN, args, {
      cwd: this.cfg.paths.root,
      env: {
        ...process.env,
        WORKSPACE_DIR: this.cfg.WORKSPACE_DIR,
        ...(this.cfg.OPENAI_API_KEY ? { OPENAI_API_KEY: this.cfg.OPENAI_API_KEY } : {}),
        OPENAI_BASE_URL: this.cfg.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
        OPENAI_ORGANIZATION: this.cfg.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORGANIZATION,
        OPENAI_PROJECT: this.cfg.OPENAI_PROJECT ?? process.env.OPENAI_PROJECT,
        PATH: buildSpawnPath(this.cfg),
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

    return { sessionId: capturedSessionId, exitCode, success, parsed, logPath };
  }

  async generateDecisionNotification(input: DecisionNotificationInput): Promise<string> {
    await ensureDir(input.thread.turnsDir);
    const baseName = `${fsTimestamp(new Date())}_decision_notification`;
    const promptPath = path.join(input.thread.turnsDir, `${baseName}.md`);
    const lastMessagePath = path.join(input.thread.turnsDir, `${baseName}.last-message.txt`);

    const prompt = buildDecisionNotificationPrompt(input);
    await writeTextAtomic(promptPath, prompt);

    const args = [
      "exec",
      "-c",
      `reasoning_effort="low"`,
      "--json",
      "--output-last-message",
      lastMessagePath,
      "--model",
      this.cfg.CODEX_MODEL,
      ...(this.cfg.CODEX_BYPASS_SANDBOX ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      prompt,
    ];

    try {
      spawnSync(this.cfg.CODEX_BIN, args, {
        cwd: this.cfg.paths.root,
        env: {
          ...process.env,
          WORKSPACE_DIR: this.cfg.WORKSPACE_DIR,
          ...(this.cfg.OPENAI_API_KEY ? { OPENAI_API_KEY: this.cfg.OPENAI_API_KEY } : {}),
          OPENAI_BASE_URL: this.cfg.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
          OPENAI_ORGANIZATION: this.cfg.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORGANIZATION,
          OPENAI_PROJECT: this.cfg.OPENAI_PROJECT ?? process.env.OPENAI_PROJECT,
          PATH: buildSpawnPath(this.cfg),
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
}

export async function ensureCodexAuth(cfg: AppConfig): Promise<void> {
  // OAuth: auth.json already written at startup, skip API key login
  if (cfg.OPENAI_CODEX_AUTH_JSON) {
    return;
  }

  if (!cfg.OPENAI_API_KEY) {
    return;
  }

  const auth = spawnSync(cfg.CODEX_BIN, ["login", "--with-api-key"], {
    cwd: cfg.paths.root,
    input: `${cfg.OPENAI_API_KEY}\n`,
    env: {
      ...process.env,
      WORKSPACE_DIR: cfg.WORKSPACE_DIR,
      OPENAI_API_KEY: cfg.OPENAI_API_KEY,
      OPENAI_BASE_URL: cfg.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
      OPENAI_ORGANIZATION: cfg.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORGANIZATION,
      OPENAI_PROJECT: cfg.OPENAI_PROJECT ?? process.env.OPENAI_PROJECT,
      PATH: buildSpawnPath(cfg),
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
