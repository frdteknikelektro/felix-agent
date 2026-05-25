import { loadConfig } from "./config.js";
import { ensureWorkspace, syncBundledSkills } from "./workspace.js";
import { log } from "./lib/log.js";
import { FelixEngine } from "./engine.js";
import { createMattermostAdapter, startMattermostSource } from "./mattermost.js";
import { startHealthServer } from "./server/health.js";
import { ensureCodexAuth } from "./codex.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  await ensureWorkspace(cfg.paths);
  await syncBundledSkills(cfg.paths);
  await ensureCodexAuth(cfg);
  const engine = new FelixEngine(cfg, [createMattermostAdapter(cfg)]);
  await engine.boot();
  const { server: health, port: healthPort } = await startHealthServer(cfg.HEALTH_PORT);
  const source = startMattermostSource(cfg, engine);
  log.info("felix.started", {
    workspace: cfg.paths.root,
    health_port: healthPort,
  });

  const shutdown = (signal: string): void => {
    log.info("felix.shutdown", { signal });
    source.stop();
    health.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  log.error("felix.fatal", { error: error.message, stack: error.stack });
  process.exit(1);
});
