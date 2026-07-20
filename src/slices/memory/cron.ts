import type { AppConfig } from "../../config.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import type { ThreadHandle } from "../sessions/index.js";
import { log } from "../../lib/log.js";
import { createOrLoadThread, listThreadHandles, loadSessionState } from "../sessions/index.js";
import { codexModelForMemorizing, opencodeModelForMemorizing, claudeCodeModelForMemorizing } from "../../core/harness-settings.js";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { buildBatchedIngestPrompt } from "./ingest.js";

const MEMORY_SYSTEM_THREAD_KEY = "memory-system";

function memorizingModel(cfg: AppConfig): string {
  if (cfg.HARNESS === "codex") return codexModelForMemorizing(cfg);
  if (cfg.HARNESS === "opencode") return opencodeModelForMemorizing(cfg);
  return claudeCodeModelForMemorizing(cfg);
}

const SCHEDULE_HOURS = [0, 6, 12, 18];

export function memoryCycleSlot(now = new Date()): string {
  const hour = SCHEDULE_HOURS.slice().reverse().find((candidate) => candidate <= now.getUTCHours()) ?? 0;
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
  if (hour === 0 && now.getUTCHours() < SCHEDULE_HOURS[0]) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 13);
}

async function memorySystemThread(cfg: AppConfig): Promise<ThreadHandle> {
  return createOrLoadThread(cfg, {
    source: "system",
    thread_key: MEMORY_SYSTEM_THREAD_KEY,
    source_thread_ref: null as never,
    received_at: new Date().toISOString(),
  });
}

export async function runMemoryCycle(cfg: AppConfig, harness: Harness): Promise<void> {
  let dirty = false;

  dirty = await runIngest(cfg, harness) || dirty;

  const checkpoint = await loadCheckpoint(cfg);
  if (shouldLint(checkpoint)) {
    const success = await runLint(cfg, harness);
    if (success) {
      checkpoint.lastLintAt = new Date().toISOString();
      dirty = true;
    }
  }

  if (dirty) {
    await saveCheckpoint(cfg, checkpoint);
  }
}

async function runIngest(cfg: AppConfig, harness: Harness): Promise<boolean> {
  const checkpoint = await loadCheckpoint(cfg);
  const threads = await listThreadHandles(cfg);
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const lastIngestTime = checkpoint.lastIngestedAt
    ? new Date(checkpoint.lastIngestedAt).getTime()
    : now - ONE_DAY_MS;

  const qualifying: string[] = [];
  for (const thread of threads) {
    const sess = await loadSessionState(thread);
    if (!sess.last_event_at) continue;
    const lastEvent = new Date(sess.last_event_at).getTime();
    if (now - lastEvent < 30 * 60 * 1000) continue;
    if (lastIngestTime < lastEvent) {
      qualifying.push(thread.dir);
    }
  }
  if (qualifying.length === 0) return false;

  log.info("memory: ingesting", { threads: qualifying.length });
  try {
    const memThread = await memorySystemThread(cfg);
    const prompt = buildBatchedIngestPrompt(cfg, qualifying);
    const result = await harness.run({
      thread: memThread,
      event: {
        source: "system",
        thread_key: MEMORY_SYSTEM_THREAD_KEY,
        event_id: `memory-ingest-${Date.now()}`,
        received_at: new Date().toISOString(),
        visibility: "channel" as const,
        mentions_bot: false,
        sender: { source: "system", id: "memory-ingest" },
        text: "",
        attachments: [],
        raw_path: "",
        source_thread_ref: null as never,
      },
      eventFile: "",
      contact: {
        user_id: "memory-ingest",
        source: "system",
        display: "Memory Ingest",
        allowed_permissions: ["memory:write"],
      },
      skills: [],
      sourceContext: { behaviorInstructions: [] },
      resumed: false,
      promptOverride: prompt,
      modelOverride: memorizingModel(cfg),
    });

    if (result.success) {
      log.info("memory: ingest succeeded", { sessionId: result.sessionId });
      return true;
    }
    log.warn("memory: ingest failed", { exitCode: result.exitCode, logPath: result.logPath });
    return false;
  } catch (err) {
    log.error("memory: ingest harness error", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function runLint(cfg: AppConfig, harness: Harness): Promise<boolean> {
  log.info("memory: linting wiki");
  try {
    const memThread = await memorySystemThread(cfg);
    const input = buildLintTurnInput(cfg, memThread);
    const result = await harness.run(input);
    if (result.success) {
      log.info("memory: lint succeeded", { sessionId: result.sessionId });
      return true;
    }
    log.warn("memory: lint failed", { exitCode: result.exitCode, logPath: result.logPath });
    return false;
  } catch (err) {
    log.error("memory: lint harness error", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function shouldLint(checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>): boolean {
  if (!checkpoint.lastLintAt) return true;
  const lastLint = new Date(checkpoint.lastLintAt).getTime();
  const since = Date.now() - lastLint;
  if (since < 24 * 60 * 60 * 1000) return false;

  if (!checkpoint.lastIngestedAt) return true;
  return new Date(checkpoint.lastIngestedAt).getTime() > lastLint;
}

function buildLintTurnInput(cfg: AppConfig, thread: ThreadHandle): TurnInput {
  const prompt = [
    "You maintain the knowledge wiki. Run a health check on the entire wiki.",
    "",
    `Wiki directory: ${cfg.paths.wikiDir}`,
    "",
    "## Checklist",
    "",
    "1. Read index.md and log.md to understand what exists and what changed recently.",
    "2. Scan all wiki pages for these issues:",
    "",
    "   - **Contradictions**: two pages make opposing claims about the same thing.",
    "     Example: entities/alice.md says 'we use PostgreSQL', concepts/database.md says 'we use MySQL'.",
    "     Flag contradictions with [CONTRADICTION] notes on both pages — do not silently resolve.",
    "",
    "   - **Stale claims**: facts that have been superseded by newer sources.",
    "     Example: a decision page says 'migration planned for June', but log.md shows it completed in May.",
    "     Update stale claims, append [SUPERSEDED] annotations, preserve the original fact.",
    "",
    "   - **Orphan pages**: pages with no inbound links from other wiki pages.",
    "     These may be fine (sessions are naturally orphaned), but flag entities and concepts that",
    "     aren't referenced anywhere — they may need links added.",
    "",
    "   - **Missing cross-references**: entities mentioned on concept pages but not linked.",
    "     Add [[wikilinks]] where connections are implied but missing.",
    "",
    "   - **Thin pages**: pages with frontmatter and a title but no meaningful body content.",
    "     If the page has sources, expand it. If it has no sources and no content, flag for deletion.",
    "",
    "3. Update index.md if page summaries have changed.",
    "4. Append a lint entry to log.md: what you checked, what you found, what you fixed.",
    "5. If you find nothing to fix, still append a clean-bill-of-health entry to log.md.",
    "",
    "Now execute: read all wiki pages, perform the health check, and fix what you find.",
    "Write actual markdown files — do not just output a plan.",
    "When writing wiki files, use atomic writes (write to a temp file then rename) to prevent corruption from concurrent access.",
  ].join("\n");

  return {
    thread,
    event: {
      source: "system",
      thread_key: MEMORY_SYSTEM_THREAD_KEY,
      event_id: `memory-lint-${Date.now()}`,
      received_at: new Date().toISOString(),
      visibility: "channel" as const,
      mentions_bot: false,
      sender: { source: "system", id: "memory-lint" },
      text: "",
      attachments: [],
      raw_path: "",
      source_thread_ref: null as never,
    },
    eventFile: "",
    contact: {
      user_id: "memory-lint",
      source: "system",
      display: "Memory Lint",
      allowed_permissions: ["memory:write"],
    },
    skills: [],
    sourceContext: { behaviorInstructions: [] },
    resumed: false,
    promptOverride: prompt,
    modelOverride: memorizingModel(cfg),
  };
}
