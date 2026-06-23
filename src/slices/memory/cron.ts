import type { AppConfig } from "../../config.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import type { ThreadHandle } from "../sessions/index.js";
import { log } from "../../lib/log.js";
import { loadSessionState, listThreadHandles } from "../sessions/index.js";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { buildBatchedIngestPrompt } from "./ingest.js";

interface CronState {
  locked: boolean;
  interval: ReturnType<typeof setInterval> | null;
}

const state: CronState = { locked: false, interval: null };

export function startMemoryCron(cfg: AppConfig, harness: Harness): void {
  if (state.interval) return;

  state.interval = setInterval(() => {
    if (state.locked) return;
    state.locked = true;
    runCycle(cfg, harness)
      .catch((err) => {
        log.error("memory: cycle failed", { err: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        state.locked = false;
      });
  }, 10 * 60 * 1000);

  state.interval.unref();
}

export function stopMemoryCron(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
}

async function runCycle(cfg: AppConfig, harness: Harness): Promise<void> {
  const checkpoint = await loadCheckpoint(cfg);
  let dirty = false;

  dirty = await runIngest(cfg, harness, checkpoint) || dirty;

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

async function runIngest(cfg: AppConfig, harness: Harness, checkpoint: Awaited<ReturnType<typeof loadCheckpoint>>): Promise<boolean> {
  const threads = await listThreadHandles(cfg);
  const now = Date.now();

  const batches: { thread: ThreadHandle; checkpoint: string | undefined }[] = [];

  for (const thread of threads) {
    const sessionState = await loadSessionState(thread);
    if (!sessionState.last_event_at) continue;

    const lastEvent = new Date(sessionState.last_event_at).getTime();
    const threadKey = thread.state.thread_key;
    const entry = checkpoint.threads[threadKey];
    const lastIngestAt = entry ? new Date(entry.lastIngestAt).getTime() : 0;

    if (lastIngestAt >= lastEvent) continue;
    if (now - lastEvent < 60 * 60 * 1000) continue;

    batches.push({ thread, checkpoint: entry?.lastIngestAt });
  }

  if (batches.length === 0) return false;

  log.info("memory: ingesting batch", { threadCount: batches.length });

  try {
    const prompt = buildBatchedIngestPrompt(cfg, batches);
    const result = await harness.run({
      thread: batches[0].thread,
      event: {
        source: "system",
        thread_key: "memory-ingest-batch",
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
    });

    if (result.success) {
      for (const batch of batches) {
        const sessionState = await loadSessionState(batch.thread);
        if (sessionState.last_event_at) {
          checkpoint.threads[batch.thread.state.thread_key] = { lastIngestAt: sessionState.last_event_at };
        }
      }
      log.info("memory: ingest batch succeeded", { threadCount: batches.length, sessionId: result.sessionId });
      return true;
    }

    log.warn("memory: ingest batch failed", { threadCount: batches.length, exitCode: result.exitCode, logPath: result.logPath });
    return false;
  } catch (err) {
    log.error("memory: ingest harness error", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function runLint(cfg: AppConfig, harness: Harness): Promise<boolean> {
  log.info("memory: linting wiki");
  try {
    const input = buildLintTurnInput(cfg);
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

  const newestIngest = Object.values(checkpoint.threads).reduce((max, entry) => {
    return Math.max(max, new Date(entry.lastIngestAt).getTime());
  }, 0);

  return newestIngest > lastLint;
}

function buildLintTurnInput(cfg: AppConfig): TurnInput {
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
  ].join("\n");

  return {
    thread: null as never,
    event: {
      source: "system",
      thread_key: "memory-lint",
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
      allowed_permissions: [],
    },
    skills: [],
    sourceContext: { behaviorInstructions: [] },
    resumed: false,
    promptOverride: prompt,
  };
}
