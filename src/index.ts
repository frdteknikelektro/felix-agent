import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { migrateWorkspaceLayout } from "./migrations.js";
import { ensureWorkspace, syncBundledSkills } from "./workspace.js";
import { log } from "./lib/log.js";
import { FelixEngine } from "./engine.js";
import { writeTextAtomic } from "./lib/fs.js";
import { createMattermostAdapter, startMattermostSource } from "./adapters/mattermost/index.js";
import { createDiscordAdapter, startDiscordSource } from "./adapters/discord/index.js";
import { createSlackAdapter, startSlackSource } from "./adapters/slack/index.js";
import { createWhatsAppAdapter, startWhatsAppSource } from "./adapters/whatsapp/index.js";
import { createTelegramAdapter, startTelegramSource } from "./adapters/telegram/index.js";
import { startAppServer } from "./server/app.js";
import { CodexHarness, ensureCodexAuth } from "./adapters/codex/index.js";
import { OpencodeHarness, ensureOpencodeAuth } from "./adapters/opencode/index.js";
import { ClaudeCodeHarness, ensureClaudeCodeAuth } from "./adapters/claude-code/index.js";
import { ninerouterEnabled } from "./core/harness-settings.js";

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
        // If the source resolved near-instantly it was intentionally disabled
        // (e.g. missing token). Do not restart — just log and exit the loop.
        if (ranMs < 100) {
          if (!shuttingDown) log.info(`${name}.disabled`, { reason: "exited_immediately" });
          break;
        }
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
// Memory schema sync
// ---------------------------------------------------------------------------

async function syncMemorySchema(paths: import("./workspace.js").WorkspacePaths): Promise<void> {
  const source = path.resolve(process.cwd(), "skills", "memory", "SKILL.md");
  const dest = path.join(paths.wikiDir, ".schema.md");
  try {
    await fs.cp(source, dest, { force: true });
  } catch {
    // schema file not found — wiki bootstraps without conventions
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  // One-time upgrade: flatten legacy records/ layout + relocate wacli store.
  // Runs before ensureWorkspace so rename targets don't pre-exist.
  await migrateWorkspaceLayout(cfg);
  await ensureWorkspace(cfg.paths);
  await syncBundledSkills(cfg.paths, {
    // 9router skill is only useful when the gateway is configured; hide it
    // otherwise so non-9router users don't see an irrelevant skill.
    skip: (name) => name === "9router" && !ninerouterEnabled(cfg),
  });
  await syncMemorySchema(cfg.paths);

  // ── SSH key setup ─────────────────────────────────────────────────────────
  // Generate an Ed25519 key pair at ~/.ssh/ if none exists. The home directory
  // is the workspace volume, so keys persist across container restarts.
  const sshDir = path.join(os.homedir(), ".ssh");
  const sshKey = path.join(sshDir, "id_ed25519");
  try {
    const keyExists = await fs.stat(sshKey).then((s) => s.isFile()).catch(() => false);
    if (keyExists) {
      log.info("ssh.exists", { key: sshKey });
    } else {
      await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
      execFileSync("ssh-keygen", [
        "-t", "ed25519",
        "-f", sshKey,
        "-N", "",
        "-C", "felix-agent",
      ], { stdio: "ignore" });
      fsSync.chmodSync(sshKey, 0o600);
      fsSync.chmodSync(`${sshKey}.pub`, 0o644);
      log.info("ssh.generated", { key: sshKey });
    }
  } catch {
    // non-fatal — SSH key setup is best-effort
  }

  // Write static L1 rulesets once at boot — never overwritten per-turn.
  // AGENTS.md carries the entire behavior contract (output format, permission
  // rules, refusal rules); a Felix without it is unsafe, so boot is fatal if
  // the file is missing rather than running contract-less.
  const agentsMdSrc = path.resolve(import.meta.dirname, "AGENTS.md");
  const agentsMd = await fs.readFile(agentsMdSrc, "utf-8").catch((err) => {
    throw new Error(
      `AGENTS.md not found at ${agentsMdSrc} — refusing to boot without the behavior contract (${err instanceof Error ? err.message : String(err)})`,
    );
  });
  // Codex/OpenCode read AGENTS.md from cwd; Claude Code reads CLAUDE.md.
  const agentsMdDst = path.join(cfg.paths.root, "AGENTS.md");
  const claudeMdDst = path.join(cfg.paths.root, "CLAUDE.md");
  await writeTextAtomic(agentsMdDst, agentsMd);
  await writeTextAtomic(claudeMdDst, agentsMd);
  // Verify the contract landed where each harness will look for it — a silent
  // miss here is exactly the failure mode that lets the agent run rule-less.
  for (const dst of [agentsMdDst, claudeMdDst]) {
    const ok = await fs.stat(dst).then((s) => s.isFile() && s.size > 0).catch(() => false);
    if (!ok) throw new Error(`Behavior contract was not written to ${dst} — refusing to start.`);
  }
  log.info("contract.written", { agents_md: agentsMdDst, claude_md: claudeMdDst, bytes: agentsMd.length });

  // Write WORKSPACE_FOLDER_STRUCTURE.md — the authoritative directory layout.
  const structSrc = path.resolve(import.meta.dirname, "WORKSPACE_FOLDER_STRUCTURE.md");
  const structMd = await fs.readFile(structSrc, "utf-8").catch(() => null);
  if (structMd) {
    const structDst = path.join(cfg.paths.root, "WORKSPACE_FOLDER_STRUCTURE.md");
    await writeTextAtomic(structDst, structMd);
  }

  let harness: import("./core/ports.js").Harness;
  switch (cfg.HARNESS) {
    case "opencode":
      await ensureOpencodeAuth(cfg);
      harness = new OpencodeHarness(cfg);
      break;
    case "claude-code":
      await ensureClaudeCodeAuth(cfg);
      harness = new ClaudeCodeHarness(cfg);
      break;
    case "codex":
    default:
      if (cfg.OPENAI_CODEX_AUTH_JSON && !ninerouterEnabled(cfg)) {
        const codexHome = path.join(cfg.paths.root, ".codex");
        const authPath = path.join(codexHome, "auth.json");
        try {
          await fs.access(authPath);
        } catch {
          await fs.mkdir(codexHome, { recursive: true });
          const authJson = cfg.OPENAI_CODEX_AUTH_JSON.replace(/^'|'$/g, "");
          await fs.writeFile(authPath, authJson, "utf-8");
          log.info("codex.auth_written", { path: authPath });
        }
      }
      await ensureCodexAuth(cfg);
      harness = new CodexHarness(cfg);
  }
  const mmAdapter = createMattermostAdapter(cfg);
  const discordAdapter = createDiscordAdapter(cfg);
  const slackAdapter = createSlackAdapter(cfg);
  const waAdapter = createWhatsAppAdapter(cfg);
  const tgAdapter = createTelegramAdapter(cfg);
  const engine = new FelixEngine(cfg, [mmAdapter, discordAdapter, slackAdapter, waAdapter, tgAdapter], harness);
  await engine.boot();

  const { server: health, port: healthPort } = await startAppServer(cfg, engine);

  await supervise("mattermost", () => startMattermostSource(cfg, engine));
  await supervise("discord", () => startDiscordSource(cfg, engine, discordAdapter));
  await supervise("slack", () => startSlackSource(cfg, engine, slackAdapter));
  await supervise("whatsapp", () => startWhatsAppSource(cfg, engine, waAdapter));
  await supervise("telegram", () => startTelegramSource(cfg, engine, tgAdapter));

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
