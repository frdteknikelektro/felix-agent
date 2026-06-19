import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { AppConfig } from "../../config.js";
import { appendText, ensureDir, writeTextAtomic } from "../../lib/fs.js";
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
  collectPermissionEvents,
  buildSpawnPath,
} from "../../core/harness-common.js";
export type { ParsedAgentOutput, PermissionRequiredOutput } from "../../core/ports.js";

// ─── Shared spawn ─────────────────────────────────────────────────────────

export interface RunResult {
  exitCode: number;
  sessionId: string;
  assistantText: string;
}

export async function opencodeRun(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  logPath: string,
): Promise<RunResult> {
  await ensureDir(path.dirname(logPath));

  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logStream = await fs.open(logPath, "a");
  const stderrStream = await fs.open(`${logPath}.stderr`, "a");

  const stdoutLines: string[] = [];
  let buf = "";

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
      await appendText(`${logPath}.stderr`, chunk.toString("utf8"));
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
  await stderrStream.close();

  let capturedSessionId = "";
  const textParts: string[] = [];

  for (const line of stdoutLines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "step_start" && typeof event.sessionID === "string" && !capturedSessionId) {
        capturedSessionId = event.sessionID;
      }
      if (event.type === "text" && typeof event.part === "object" && event.part !== null) {
        const part = event.part as Record<string, unknown>;
        if (part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
    } catch {
    }
  }

  const assistantText = textParts.join("");

  return { exitCode, sessionId: capturedSessionId, assistantText };
}

// ─── Harness ──────────────────────────────────────────────────────────────

export class OpencodeHarness implements Harness {
  constructor(private readonly cfg: AppConfig) {}

  private buildEnv(): Record<string, string | undefined> {
    return {
      WORKSPACE_DIR: this.cfg.WORKSPACE_DIR,
      OPENAI_API_KEY: this.cfg.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      OPENCODE_API_KEY: this.cfg.OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY,
      DEEPSEEK_API_KEY: this.cfg.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY,
      XDG_DATA_HOME: `${this.cfg.paths.runtime}/.local`,
      XDG_CONFIG_HOME: `${this.cfg.paths.runtime}/.config`,
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
    const permissionEvents = input.promptOverride ? [] : await collectPermissionEvents(input.thread);
    const prompt = input.promptOverride ?? buildTurnPrompt(this.cfg, input, sessionId, permissionEvents);

    await writeTextAtomic(turnPath, prompt);

    const baseArgs = [
      "run",
      "--dir", this.cfg.paths.root,
      "--model", this.cfg.OPENCODE_MODEL,
      "--format", "json",
      "--dangerously-skip-permissions",
    ];
    if (this.cfg.OPENCODE_VARIANT) {
      baseArgs.push("--variant", this.cfg.OPENCODE_VARIANT);
    }

    const args = hasSession
      ? [...baseArgs, "--session", sessionId, prompt]
      : [...baseArgs, prompt];

    const { exitCode, sessionId: capturedSessionId, assistantText } =
      await opencodeRun(this.cfg.OPENCODE_BIN, args, this.cfg.paths.root, this.buildEnv(), logPath);

    if (capturedSessionId && capturedSessionId !== sessionState.harness_session_id) {
      input.thread.session.harness_session_id = capturedSessionId;
    }

    const parsed = parseAgentOutput(assistantText);
    const success = exitCode === 0 && hasRenderableOutput(parsed);

    return { sessionId: capturedSessionId || sessionId, exitCode, success, parsed, logPath };
  }

  async generateDecisionNotification(input: DecisionNotificationInput): Promise<string> {
    await ensureDir(input.thread.turnsDir);
    const baseName = `${fsTimestamp(new Date())}_decision_notification`;
    const promptPath = path.join(input.thread.turnsDir, `${baseName}.md`);
    const logPath = path.join(input.thread.turnsDir, `${baseName}.log`);

    const prompt = buildDecisionNotificationPrompt(input);
    await writeTextAtomic(promptPath, prompt);

    const args = [
      "run",
      "--dir", this.cfg.paths.root,
      "--model", this.cfg.OPENCODE_MODEL,
      "--format", "json",
      "--dangerously-skip-permissions",
      prompt,
    ];

    try {
      const { assistantText } = await opencodeRun(
        this.cfg.OPENCODE_BIN,
        args,
        this.cfg.paths.root,
        this.buildEnv(),
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
}

export async function ensureOpencodeAuth(cfg: AppConfig): Promise<void> {
  const check = spawnSync(cfg.OPENCODE_BIN, ["--version"], {
    cwd: cfg.paths.root,
    env: {
      ...process.env,
      WORKSPACE_DIR: cfg.WORKSPACE_DIR,
      XDG_DATA_HOME: `${cfg.paths.runtime}/.local`,
      XDG_CONFIG_HOME: `${cfg.paths.runtime}/.config`,
      PATH: buildSpawnPath(cfg),
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  if (check.status !== 0) {
    const stderr = typeof check.stderr === "string" ? check.stderr.trim() : "";
    const stdout = typeof check.stdout === "string" ? check.stdout.trim() : "";
    throw new Error(`opencode binary check failed: ${stderr || stdout || `exit ${check.status ?? -1}`}`);
  }
}
