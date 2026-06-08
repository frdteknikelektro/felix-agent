import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readText, writeTextAtomic } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { AppConfig } from "../../config.js";

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

export async function classifyOwnerDecisionViaCodex(
  text: string,
  cfg: AppConfig,
): Promise<"once" | "always" | "reject" | null> {
  if (!cfg.OPENAI_API_KEY) return null;
  const prompt = CLASSIFY_PROMPT.replace("__MESSAGE__", text);
  const workDir = path.join(cfg.paths.approvals, "_classify");
  const runId = `${fsTimestamp(new Date())}_${crypto.randomUUID().slice(0, 8)}`;
  const turnPath = path.join(workDir, `${runId}.md`);
  const outputLastMessagePath = `${turnPath}.last-message.txt`;

  await ensureDir(workDir);
  await writeTextAtomic(turnPath, prompt);

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    cfg.CODEX_MODEL,
    "--output-last-message",
    outputLastMessagePath,
    prompt,
  ];

  const child = spawn(cfg.CODEX_BIN, args, {
    cwd: workDir,
    env: {
      ...process.env,
      OPENAI_API_KEY: cfg.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: cfg.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
      OPENAI_ORGANIZATION: cfg.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORGANIZATION,
      OPENAI_PROJECT: cfg.OPENAI_PROJECT ?? process.env.OPENAI_PROJECT,
      PATH: buildSpawnPath(),
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
  // Extract word between FELIX_REPLY / END_FELIX_REPLY, or take first word
  const reply = between(lastMessage, "FELIX_REPLY", "END_FELIX_REPLY");
  const result = ((reply ?? lastMessage) || "").trim().toLowerCase();
  if (result.startsWith("once")) return "once";
  if (result.startsWith("always")) return "always";
  if (result.startsWith("reject")) return "reject";
  return null;
}

function between(text: string, startMarker: string, endMarker: string): string | null {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const after = start + startMarker.length;
  const end = text.indexOf(endMarker, after);
  if (end < 0) return null;
  return text.slice(after, end);
}

function buildSpawnPath(): string {
  const localBin = path.resolve(process.cwd(), "node_modules", ".bin");
  const current = process.env.PATH ?? "";
  return current.includes(localBin) ? current : `${localBin}:${current}`;
}
