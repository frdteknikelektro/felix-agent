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

export class OpencodeHarness implements Harness {
  constructor(private readonly cfg: AppConfig) {}

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
    const permissionEvents = await collectPermissionEvents(input.thread);
    const prompt = buildTurnPrompt(this.cfg, input, sessionId, permissionEvents);

    await writeTextAtomic(turnPath, prompt);

    const baseArgs = [
      "run",
      "--format",
      "json",
      "--dir",
      this.cfg.paths.root,
      "--dangerously-skip-permissions",
      "--model",
      this.cfg.OPENCODE_MODEL,
    ];
    if (this.cfg.OPENCODE_VARIANT) {
      baseArgs.push("--variant", this.cfg.OPENCODE_VARIANT);
    }

    const args = hasSession
      ? [...baseArgs, "--session", sessionId, prompt]
      : [...baseArgs, prompt];

    let capturedSessionId = sessionId;
    const child = spawn(this.cfg.OPENCODE_BIN, args, {
      cwd: this.cfg.paths.root,
      env: {
        ...process.env,
        WORKSPACE_DIR: this.cfg.WORKSPACE_DIR,
        OPENCODE_API_KEY: this.cfg.OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY,
        DEEPSEEK_API_KEY: this.cfg.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY,
        PATH: buildSpawnPath(this.cfg),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await ensureDir(path.dirname(logPath));
    const logStream = await fs.open(logPath, "a");
    const stderrStream = await fs.open(`${logPath}.stderr`, "a");

    const stdoutBuf: string[] = [];

    const exitCode = await new Promise<number>((resolve) => {
      child.stdout.on("data", async (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutBuf.push(text);
        await appendText(logPath, text);
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            if (event.type === "session.created" && typeof event.session_id === "string") {
              capturedSessionId = event.session_id;
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
        log.error("opencode.spawn_error", { error: error.message });
        resolve(-1);
      });
    });

    await logStream.close();
    await stderrStream.close();

    // If no session existed before, capture the session ID from opencode
    if (!hasSession) {
      try {
        const listResult = spawnSync(this.cfg.OPENCODE_BIN, ["session", "list", "--format", "json", "--max-count", "1"], {
          cwd: this.cfg.paths.root,
          env: {
            ...process.env,
            WORKSPACE_DIR: this.cfg.WORKSPACE_DIR,
            PATH: buildSpawnPath(this.cfg),
          },
          encoding: "utf8",
          timeout: 10_000,
        });
        if (listResult.status === 0 && listResult.stdout) {
          const entries = JSON.parse(listResult.stdout) as Array<{ id: string }>;
          if (Array.isArray(entries) && entries.length > 0 && entries[0].id) {
            capturedSessionId = entries[0].id;
          }
        }
      } catch {
        // keep generated session ID
      }
    }

    if (capturedSessionId !== sessionState.harness_session_id) {
      input.thread.session.harness_session_id = capturedSessionId;
    }

    // Parse the full stdout for FELIX_REPLY/PERMISSION_REQUIRED markers
    const fullOutput = stdoutBuf.join("");
    const parsed = parseAgentOutput(fullOutput);
    const success = exitCode === 0 && hasRenderableOutput(parsed);

    return { sessionId: capturedSessionId, exitCode, success, parsed, logPath };
  }

  async generateDecisionNotification(input: DecisionNotificationInput): Promise<string> {
    await ensureDir(input.thread.turnsDir);
    const baseName = `${fsTimestamp(new Date())}_decision_notification`;
    const promptPath = path.join(input.thread.turnsDir, `${baseName}.md`);

    const prompt = buildDecisionNotificationPrompt(input);
    await writeTextAtomic(promptPath, prompt);

    const args = [
      "run",
      "--dir",
      this.cfg.paths.root,
      "--dangerously-skip-permissions",
      "--model",
      this.cfg.OPENCODE_MODEL,
      prompt,
    ];

    try {
      const result = spawnSync(this.cfg.OPENCODE_BIN, args, {
        cwd: this.cfg.paths.root,
        env: {
          ...process.env,
          WORKSPACE_DIR: this.cfg.WORKSPACE_DIR,
          OPENCODE_API_KEY: this.cfg.OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY,
          DEEPSEEK_API_KEY: this.cfg.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY,
          PATH: buildSpawnPath(this.cfg),
        },
        timeout: 60_000,
        encoding: "utf8",
      });

      const stdout = result.stdout ?? "";
      const reply = between(stdout, "FELIX_REPLY", "END_FELIX_REPLY");
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
