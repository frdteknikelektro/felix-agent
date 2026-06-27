#!/usr/bin/env node
// Usage report wrapper. The read model lives in src/slices/usage and is compiled
// into /app/dist in the runtime image; this skill delegates to that Module so
// chat reports and the owner console cannot drift.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function locateReportCli() {
  const explicit = process.env.FELIX_USAGE_REPORT_CLI;
  const appDir = process.env.FELIX_APP_DIR || "/app";
  const candidates = [
    explicit,
    path.join(appDir, "dist", "slices", "usage", "report-cli.js"),
    path.join(process.cwd(), "dist", "slices", "usage", "report-cli.js"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return { kind: "compiled", file: candidate };
  }
  const devTsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const devCli = path.join(process.cwd(), "src", "slices", "usage", "report-cli.ts");
  if (await pathExists(devTsx) && await pathExists(devCli)) {
    return { kind: "tsx", runner: devTsx, file: devCli };
  }
  throw new Error(
    `compiled Usage report CLI not found; checked ${candidates.join(", ")}. Build Felix or set FELIX_USAGE_REPORT_CLI.`,
  );
}

async function runTsxCli(runner) {
  const child = spawn(runner.runner, [runner.file, ...process.argv.slice(2)], {
    env: process.env,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) process.exit(code);
}

async function main() {
  const cli = await locateReportCli();
  if (cli.kind === "tsx") {
    await runTsxCli(cli);
    return;
  }
  const mod = await import(pathToFileURL(cli.file).href);
  await mod.main(process.argv, process.env);
}

export { locateReportCli };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`usage-report failed: ${err?.message || err}\n`);
    process.exit(1);
  });
}
