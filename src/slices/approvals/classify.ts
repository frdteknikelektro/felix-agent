import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readText, writeTextAtomic } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { AppConfig } from "../../config.js";
import { between } from "../../core/harness-common.js";
import { opencodeRun } from "../../adapters/opencode/index.js";
import { claudeCodeRun } from "../../adapters/claude-code/index.js";
import {
  claudeCodeSettings,
  codexSettings,
  hasClaudeCodeAuth,
  hasCodexAuth,
  hasOpencodeAuth,
  opencodeSettings,
} from "../../core/harness-settings.js";

const CLASSIFY_PROMPT = [
  "Classify this message from an owner responding to a permission request.",
  "",
  "Categories:",
  '- "once": approve just this one time ("yes", "ok just this time", "do it", "this time only")',
  '- "always": approve permanently ("yes forever", "grant access", "always allow", "ok always")',
  '- "reject": deny the request ("no", "deny", "do not allow", "nah", "reject")',
  '- "none": not a permission decision ("hello", casual chat, questions, unrelated)',
  "",
  "Message:",
  "---",
  "__MESSAGE__",
  "---",
  "",
  "Respond with ONLY the single word: once, always, reject, or none.",
  "",
  "FELIX_REPLY",
  "<word>",
  "END_FELIX_REPLY",
].join("\n");

export async function classifyOwnerDecision(
  text: string,
  cfg: AppConfig,
): Promise<"once" | "always" | "reject" | null> {
  if (cfg.HARNESS === "opencode") {
    return classifyViaOpencode(text, cfg);
  }
  if (cfg.HARNESS === "claude-code") {
    return classifyViaClaudeCode(text, cfg);
  }
  return classifyViaCodex(text, cfg);
}

async function classifyViaCodex(
  text: string,
  cfg: AppConfig,
): Promise<"once" | "always" | "reject" | null> {
  if (!hasCodexAuth(cfg)) return null;
  const prompt = CLASSIFY_PROMPT.replace("__MESSAGE__", text);
  const workDir = path.join(cfg.paths.approvals, "_classify");
  const runId = `${fsTimestamp(new Date())}_${crypto.randomUUID().slice(0, 8)}`;
  const turnPath = path.join(workDir, `${runId}.md`);
  const outputLastMessagePath = `${turnPath}.last-message.txt`;
  const settings = codexSettings(cfg);

  await ensureDir(workDir);
  await writeTextAtomic(turnPath, prompt);

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    settings.model,
    "--output-last-message",
    outputLastMessagePath,
    prompt,
  ];

  const child = spawn(cfg.CODEX_BIN, args, {
    cwd: workDir,
    env: {
      ...process.env,
      ...settings.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });

  const stderrBuf: string[] = [];

  const exitCode = await new Promise<number>((resolve) => {
    child.stdout.on("data", () => {
      // stdout is JSON stream; we read the last-message file instead
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk.toString("utf8"));
    });
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", (error) => {
      log.warn("classify.spawn_error", { error: error.message });
      resolve(-1);
    });
  });

  if (exitCode !== 0) {
    log.warn("classify.nonzero_exit", { exitCode, stderr: stderrBuf.join("").slice(0, 200) });
    return null;
  }

  const lastMessage = await readText(outputLastMessagePath, "");
  const reply = between(lastMessage, "FELIX_REPLY", "END_FELIX_REPLY");
  const result = ((reply ?? lastMessage) || "").trim().toLowerCase();
  if (result.startsWith("once")) return "once";
  if (result.startsWith("always")) return "always";
  if (result.startsWith("reject")) return "reject";
  return null;
}

async function classifyViaOpencode(
  text: string,
  cfg: AppConfig,
): Promise<"once" | "always" | "reject" | null> {
  if (!hasOpencodeAuth(cfg)) return null;

  const prompt = CLASSIFY_PROMPT.replace("__MESSAGE__", text);
  const workDir = path.join(cfg.paths.approvals, "_classify");
  const runId = `${fsTimestamp(new Date())}_${crypto.randomUUID().slice(0, 8)}`;
  const turnPath = path.join(workDir, `${runId}.md`);
  const logPath = `${turnPath}.log`;
  const settings = opencodeSettings(cfg);

  await ensureDir(workDir);
  await writeTextAtomic(turnPath, prompt);

  const args = [
    "run",
    "--dir", workDir,
    "--model", settings.model,
    "--format", "json",
    "--dangerously-skip-permissions",
    prompt,
  ];

  // Add a timeout to avoid hanging if opencode is slow
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const { exitCode, assistantText } = await opencodeRun(
      cfg.OPENCODE_BIN,
      args,
      workDir,
      settings.env,
      logPath,
      controller.signal,
    );

    if (exitCode !== 0) {
      log.warn("classify.opencode_nonzero_exit", { exitCode });
      return null;
    }

    const reply = between(assistantText, "FELIX_REPLY", "END_FELIX_REPLY");
    const word = ((reply ?? assistantText) || "").trim().toLowerCase();
    if (word.startsWith("once")) return "once";
    if (word.startsWith("always")) return "always";
    if (word.startsWith("reject")) return "reject";
    return null;
  } catch (error) {
    log.warn("classify.opencode_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyViaClaudeCode(
  text: string,
  cfg: AppConfig,
): Promise<"once" | "always" | "reject" | null> {
  if (!hasClaudeCodeAuth(cfg)) return null;
  const prompt = CLASSIFY_PROMPT.replace("__MESSAGE__", text);
  const workDir = path.join(cfg.paths.approvals, "_classify");
  const runId = `${fsTimestamp(new Date())}_${crypto.randomUUID().slice(0, 8)}`;
  const turnPath = path.join(workDir, `${runId}.md`);
  const logPath = `${turnPath}.log`;
  const settings = claudeCodeSettings(cfg);

  await ensureDir(workDir);
  await writeTextAtomic(turnPath, prompt);

  const args = [
    "-p",
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--model", settings.model,
    prompt,
  ];

  try {
    const { exitCode, assistantText } = await claudeCodeRun(
      cfg.CLAUDE_CODE_BIN,
      args,
      workDir,
      settings.env,
      logPath,
    );

    if (exitCode !== 0) {
      log.warn("classify.claude-code_nonzero_exit", { exitCode });
      return null;
    }

    const reply = between(assistantText, "FELIX_REPLY", "END_FELIX_REPLY");
    const word = ((reply ?? assistantText) || "").trim().toLowerCase();
    if (word.startsWith("once")) return "once";
    if (word.startsWith("always")) return "always";
    if (word.startsWith("reject")) return "reject";
    return null;
  } catch (error) {
    log.warn("classify.claude-code_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

