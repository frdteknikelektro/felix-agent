import fs from "node:fs/promises";
import path from "node:path";
import { readText, writeTextAtomic } from "../lib/fs.js";
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

/**
 * Append a compacted context section to INITIAL.md. This is used after
 * compaction to preserve the summary for the next session.
 */
export async function appendCompactedContext(threadDir: string, summary: string): Promise<void> {
  const initialPath = path.join(threadDir, "INITIAL.md");
  const existing = await readText(initialPath, "");
  
  // Remove old compacted context section if it exists
  const compactedMarker = "\n## Compacted Context\n";
  const compactedIndex = existing.indexOf(compactedMarker);
  const baseContent = compactedIndex >= 0 ? existing.substring(0, compactedIndex) : existing.replace(/\n---\n\*INITIAL\.md is written once at session start\. Do not rewrite it\.\*$/, "");
  
  // Build new content with compacted context
  const sections: string[] = [
    baseContent.trimEnd(),
    "",
    "## Compacted Context",
    "",
    "The conversation was compacted. Use this summary as context for the new session:",
    "",
    summary,
    "",
    "---",
    "*INITIAL.md is written once at session start. Do not rewrite it.*",
  ];
  
  await writeTextAtomic(initialPath, sections.join("\n"));
}
