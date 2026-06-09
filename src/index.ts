import { loadConfig } from "./config.js";
import { ensureWorkspace, syncBundledSkills } from "./workspace.js";
import { log } from "./lib/log.js";
import { FelixEngine } from "./engine.js";
import { createMattermostAdapter, startMattermostSource } from "./adapters/mattermost/index.js";
import { createDiscordAdapter, startDiscordSource } from "./adapters/discord/index.js";
import { createSlackAdapter, startSlackSource } from "./adapters/slack/index.js";
import { startAppServer } from "./server/app.js";
import { CodexHarness, ensureCodexAuth } from "./adapters/codex/index.js";
import { OpencodeHarness, ensureOpencodeAuth } from "./adapters/opencode/index.js";

// ---------------------------------------------------------------------------
// Supervisor — restarts a subsystem with exponential backoff on failure
// ---------------------------------------------------------------------------

interface SuperviseOpts {
  /** Base delay before first restart, doubles each attempt up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each restart attempt. Return false to stop supervising. */
  shouldRestart?: () => boolean;
}

async function supervise(
  name: string,
  start: () => Promise<{ stop(): void; done: Promise<void> }>,
  opts: SuperviseOpts = {},
): Promise<void> {
  const { baseDelayMs = 2_000, maxDelayMs = 60_000, shouldRestart = () => !shuttingDown } = opts;
  let delay = baseDelayMs;
  let stop: (() => void) | null = null;

  const run = async (): Promise<void> => {
    while (shouldRestart()) {
      const startedAt = Date.now();
      try {
        log.info(`${name}.starting`);
        const source = await start();
        stop = source.stop;
        // Block until stop() is called or the source exits on its own.
        // The adapter's internal reconnect handles transient WS drops — the
        // supervisor only intervenes when done resolves without stop() (fatal).
        await source.done;
        const ranMs = Date.now() - startedAt;
        // Reset backoff only if source ran long enough to be considered healthy.
        if (ranMs >= maxDelayMs) delay = baseDelayMs;
        if (!shuttingDown) {
          log.warn(`${name}.exited`, { restarting_in_ms: delay });
        }
      } catch (error) {
        log.error(`${name}.crashed`, {
          error: error instanceof Error ? error.message : String(error),
          restarting_in_ms: delay,
        });
      }
      stop = null;
      if (!shuttingDown && !shouldRestart()) break;
      if (!shuttingDown) await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  };

  void run();

  // Expose the current stop handle via the module-level ref
  supervisedSources.set(name, () => stop?.());
}

const supervisedSources = new Map<string, () => void>();
let shuttingDown = false;

function stopAll(): void {
  for (const stop of supervisedSources.values()) {
    try {
      stop();
    } catch {
      // best-effort
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  await ensureWorkspace(cfg.paths);
  await syncBundledSkills(cfg.paths);
  let harness: import("./core/ports.js").Harness;
  switch (cfg.HARNESS) {
    case "opencode":
      await ensureOpencodeAuth(cfg);
      harness = new OpencodeHarness(cfg);
      break;
    case "codex":
    default:
      await ensureCodexAuth(cfg);
      harness = new CodexHarness(cfg);
  }
  const mmAdapter = createMattermostAdapter(cfg);
  const discordAdapter = createDiscordAdapter(cfg);
  const slackAdapter = createSlackAdapter(cfg);
  const engine = new FelixEngine(cfg, [mmAdapter, discordAdapter, slackAdapter], harness);
  await engine.boot();

  const { server: health, port: healthPort } = await startAppServer(cfg, engine, cfg.HEALTH_PORT);

  await supervise("mattermost", () => startMattermostSource(cfg, engine));
  await supervise("discord", () => startDiscordSource(cfg, engine, discordAdapter));
  await supervise("slack", () => startSlackSource(cfg, engine, slackAdapter));

  log.info("felix.started", {
    workspace: cfg.paths.root,
    health_port: healthPort,
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("felix.shutdown", { signal });

    // 1. Stop accepting new events from all sources
    stopAll();

    // 2. Drain in-flight thread processing (up to 15 s)
    try {
      await engine.drain(15_000);
    } catch {
      // non-fatal — continue shutdown regardless
    }

    // 3. Close the health / owner server
    health.close(() => process.exit(0));

    // 4. Hard exit if graceful close stalls
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log.error("felix.fatal", { error: error instanceof Error ? error.message : String(error), stack: (error as Error).stack });
  process.exit(1);
});
