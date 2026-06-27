import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseUsageWindow, usageReportFromDirectory, USAGE_WINDOWS } from "./index.js";

export async function main(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const workspace = env.WORKSPACE_DIR || "/home/node/workspace";
  const usageDirectory = path.join(workspace, "usage");
  const tz = env.USAGE_TZ || "UTC";
  const requested = parseUsageWindow(argv[2]);
  const windows = requested ? [requested] : USAGE_WINDOWS;
  const report = await usageReportFromDirectory(usageDirectory, tz, windows);
  process.stdout.write(`${report}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`usage-report failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
