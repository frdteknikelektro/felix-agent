import path from "node:path";
import { writeTextAtomic } from "./lib/fs.js";
import type { WorkspacePaths } from "./workspace.js";

export async function installWorkspacePathCommand(
  paths: WorkspacePaths,
  cliModulePath: string,
  nodePath = process.execPath,
): Promise<string> {
  const wrapper = path.join(paths.bin, "felix-workspace-path");
  const script = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliModulePath)} "$@"\n`;
  await writeTextAtomic(wrapper, script, 0o755);
  return wrapper;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
