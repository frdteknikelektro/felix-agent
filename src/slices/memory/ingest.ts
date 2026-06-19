import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import type { ThreadHandle } from "../sessions/index.js";
import { readText } from "../../lib/fs.js";

function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "(file does not exist yet)";
  }
}

function threadKeySlug(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function sessionFileName(thread: ThreadHandle): string {
  const date = thread.state.created_at.slice(0, 10);
  return `${date}_${thread.state.source}_${threadKeySlug(thread.state.thread_key)}.md`;
}

export function buildIngestPrompt(cfg: AppConfig, thread: ThreadHandle, checkpoint: string | undefined): string {
  const wikiDir = cfg.paths.wikiDir;
  const schemaPath = path.join(wikiDir, ".schema.md");
  const indexPath = path.join(wikiDir, "index.md");

  const schema = readIfExists(schemaPath);
  const index = readIfExists(indexPath);
  const transcript = readIfExists(thread.transcriptFile);

  const newAfter = checkpoint
    ? `\n(Only process events newer than ${checkpoint}. Do not re-ingest older content.)\n`
    : "";

  return [
    "You maintain a personal, interlinked knowledge wiki.",
    "",
    `Wiki directory: ${wikiDir}`,
    "",
    `## Wiki conventions (.schema.md)`,
    "Read and follow these conventions for every page you create or update:",
    "",
    schema,
    "",
    "## Current wiki state (index.md)",
    "This is the catalog of everything currently in the wiki. Read it to avoid duplication.",
    "Update existing pages when new facts emerge — never create duplicate pages for the same entity or concept.",
    "",
    index,
    "",
    "## Conversation transcript to ingest",
    `Source: ${thread.state.source}`,
    `Thread key: ${thread.state.thread_key}`,
    `Session file: ${sessionFileName(thread)}`,
    newAfter,
    "---",
    transcript,
    "---",
    "",
    "## Your task",
    "",
    "1. Read the transcript and extract structured knowledge:",
    "   - Entities (people, projects, tools, services) — who and what is mentioned",
    "   - Concepts (ideas, patterns, architectural decisions, trade-offs)",
    "   - Decisions (what was decided, by whom, with what reasoning)",
    "   - Preferences (what someone likes, dislikes, or always does)",
    "   - Facts (anything asserted as true about a system, process, or domain)",
    "",
    "2. Create or update wiki pages:",
    `   - Entity pages go in ${wikiDir}/entities/ — one per person, project, tool, service`,
    `   - Concept pages go in ${wikiDir}/concepts/ — ideas, patterns, architectural decisions`,
    `   - Session summaries go in ${wikiDir}/sessions/${thread.state.source}/ — one per ingested transcript`,
    `   - Comparisons go in ${wikiDir}/comparisons/ — side-by-side analyses (only when two things are explicitly compared)`,
    "   - Every page starts with YAML frontmatter: title, type, tags, updated_at, sources",
    "   - Cross-link pages with [[../entities/page-name]] or [[page-name]] wikilinks",
    "   - Update existing pages rather than creating duplicates — add new facts, update summaries, add links",
    "",
    "3. Update the index and log:",
    "   - Update index.md: add new page entries, update summaries of changed pages",
    "   - Append to log.md: timestamped entry listing what was created, updated, and linked",
    "",
    "4. Update overview.md and synthesis.md if new information shifts the big picture:",
    "   - overview.md pulls threads together — major themes, active projects, open questions",
    "   - synthesis.md is the evolving thesis — your best understanding of the domain so far",
    "",
    "5. Be thorough. A single conversation can contain many entities, concepts, and decisions.",
    "   Create pages even for things mentioned briefly — future conversations will fill them in.",
    "   A thin page with frontmatter and one sentence is better than no page.",
    "   Never silently discard information — if it was said, it belongs in the wiki.",
    "",
    "Now execute: read the existing wiki pages you need, then write all new and updated files.",
    "Write actual markdown files — do not just output a plan.",
  ].join("\n");
}

function buildThreadSection(thread: ThreadHandle, checkpoint: string | undefined): string {
  const transcript = readIfExists(thread.transcriptFile);
  const newAfter = checkpoint
    ? `\n(Only process events newer than ${checkpoint}. Do not re-ingest older content.)\n`
    : "";

  return [
    `## Conversation: ${thread.state.source} — ${thread.state.thread_key}`,
    `Session: ${sessionFileName(thread)}`,
    newAfter,
    "---",
    transcript,
    "---",
  ].join("\n");
}

export function buildBatchedIngestPrompt(
  cfg: AppConfig,
  batches: { thread: ThreadHandle; checkpoint: string | undefined }[],
): string {
  const wikiDir = cfg.paths.wikiDir;
  const schemaPath = path.join(wikiDir, ".schema.md");
  const indexPath = path.join(wikiDir, "index.md");

  const schema = readIfExists(schemaPath);
  const index = readIfExists(indexPath);

  const transcripts = batches
    .map((b) => buildThreadSection(b.thread, b.checkpoint))
    .join("\n\n");

  return [
    "You maintain a personal, interlinked knowledge wiki.",
    "",
    `Wiki directory: ${wikiDir}`,
    "",
    `## Wiki conventions (.schema.md)`,
    "Read and follow these conventions for every page you create or update:",
    "",
    schema,
    "",
    "## Current wiki state (index.md)",
    "This is the catalog of everything currently in the wiki. Read it to avoid duplication.",
    "Update existing pages when new facts emerge — never create duplicate pages for the same entity or concept.",
    "",
    index,
    "",
    "## Conversation transcripts to ingest",
    `(${batches.length} thread${batches.length > 1 ? "s" : ""} to process)`,
    "",
    transcripts,
    "",
    "## Your task",
    "",
    "1. Read all transcripts and extract structured knowledge:",
    "   - Entities (people, projects, tools, services) — who and what is mentioned",
    "   - Concepts (ideas, patterns, architectural decisions, trade-offs)",
    "   - Decisions (what was decided, by whom, with what reasoning)",
    "   - Preferences (what someone likes, dislikes, or always does)",
    "   - Facts (anything asserted as true about a system, process, or domain)",
    "",
    "2. Create or update wiki pages:",
    `   - Entity pages go in ${wikiDir}/entities/ — one per person, project, tool, service`,
    `   - Concept pages go in ${wikiDir}/concepts/ — ideas, patterns, architectural decisions`,
    `   - Session summaries go in ${wikiDir}/sessions/<source>/ — one per ingested transcript`,
    `   - Comparisons go in ${wikiDir}/comparisons/ — side-by-side analyses (only when two things are explicitly compared)`,
    "   - Every page starts with YAML frontmatter: title, type, tags, updated_at, sources",
    "   - Cross-link pages with [[../entities/page-name]] or [[page-name]] wikilinks",
    "   - Update existing pages rather than creating duplicates — add new facts, update summaries, add links",
    "",
    "3. Update the index and log:",
    "   - Update index.md: add new page entries, update summaries of changed pages",
    "   - Append to log.md: timestamped entry listing what was created, updated, and linked",
    "",
    "4. Update overview.md and synthesis.md if new information shifts the big picture:",
    "   - overview.md pulls threads together — major themes, active projects, open questions",
    "   - synthesis.md is the evolving thesis — your best understanding of the domain so far",
    "",
    "5. Be thorough. A single conversation can contain many entities, concepts, and decisions.",
    "   Create pages even for things mentioned briefly — future conversations will fill them in.",
    "   A thin page with frontmatter and one sentence is better than no page.",
    "   Never silently discard information — if it was said, it belongs in the wiki.",
    "",
    "Now execute: read the existing wiki pages you need, then write all new and updated files.",
    "Write actual markdown files — do not just output a plan.",
  ].join("\n");
}

export function buildIngestTurnInput(cfg: AppConfig, thread: ThreadHandle, checkpoint: string | undefined): TurnInput {
  return {
    thread,
    event: {
      source: thread.state.source,
      thread_key: thread.state.thread_key,
      event_id: `memory-ingest-${Date.now()}`,
      received_at: new Date().toISOString(),
      visibility: "channel" as const,
      mentions_bot: false,
      sender: { source: "system", id: "memory-ingest" },
      text: "",
      attachments: [],
      raw_path: "",
      source_thread_ref: thread.state.source_thread_ref,
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
    promptOverride: buildIngestPrompt(cfg, thread, checkpoint),
  };
}
