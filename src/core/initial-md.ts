import path from "node:path";
import { writeTextAtomic } from "../lib/fs.js";
import type { AppConfig } from "../config.js";

interface InitialMdInput {
  cfg: AppConfig;
  sessionId: string;
  harnessType: string;
  threadDir: string;
  behaviorInstructions: string[];
}

/**
 * Build and persist INITIAL.md for a session.  Called once on the first turn
 * of each session; never rewritten for resumed turns.
 *
 * INITIAL.md is written inside the thread directory so the CLI tools can
 * locate it relative to the session root.
 */
export async function buildInitialMd(input: InitialMdInput): Promise<string> {
  const { cfg, sessionId, harnessType, threadDir, behaviorInstructions } = input;
  const initialPath = path.join(threadDir, "INITIAL.md");

  const sections: string[] = [
    `# Session Context`,
    "",
    `| Key | Value |`,
    `|-----|-------|`,
    `| Session ID | \`${sessionId}\` |`,
    `| Harness | \`${harnessType}\` |`,
    `| Working directory | \`${cfg.paths.root}\` |`,
    `| Workspace root | \`${cfg.WORKSPACE_DIR}\` |`,
    "",
  ];

  if (behaviorInstructions.length > 0) {
    sections.push("## Platform Instructions", "");
    sections.push("Use the following bash commands for platform interactions:");
    sections.push("");
    for (const instruction of behaviorInstructions) {
      sections.push(instruction);
      sections.push("");
    }
  }

  sections.push("---");
  sections.push("*INITIAL.md is written once at session start. Do not rewrite it.*");

  const content = sections.join("\n");
  await writeTextAtomic(initialPath, content);
  return initialPath;
}
