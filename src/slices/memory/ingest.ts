import path from "node:path";
import type { AppConfig } from "../../config.js";
import type { TurnInput } from "../../core/ports.js";
import type { ThreadHandle } from "../sessions/index.js";

const ATOMIC_WRITE_NOTE = "When writing wiki or checkpoint files, use atomic writes (write to a temp file then rename) to prevent corruption from concurrent access.";

export function buildIngestPrompt(cfg: AppConfig, thread: ThreadHandle, checkpoint: string | undefined): string {
  const wikiDir = cfg.paths.wikiDir;
  const schemaPath = path.join(wikiDir, ".schema.md");
  const indexPath = path.join(wikiDir, "index.md");

  const newAfter = checkpoint
    ? `\n(Only process events newer than ${checkpoint}. Do not re-ingest older content.)\n`
    : "";

  return [
    "You maintain a personal, interlinked knowledge wiki.",
    "",
    `Wiki directory: ${wikiDir}`,
    "",
    "## Preparation",
    `1. Read ${schemaPath} — wiki conventions: page format, YAML frontmatter, directory structure, cross-linking rules.`,
    `2. Read ${indexPath} — catalog of everything already in the wiki. Use it to avoid duplicate pages.`,
    "",
    `## Conversation to ingest`,
    `Source: ${thread.state.source}`,
    `Thread key: ${thread.state.thread_key}`,
    `Transcript: ${thread.transcriptFile}`,
    newAfter,
    "",
    "## Your task",
    "",
    "1. Read the transcript and extract structured knowledge:",
    "   - Entities (people, projects, tools, services)",
    "   - Concepts (ideas, patterns, architectural decisions, trade-offs)",
    "   - Decisions (what was decided, by whom, with what reasoning)",
    "   - Preferences (what someone likes, dislikes, or always does)",
    "   - Facts (anything asserted as true about a system, process, or domain)",
    "",
    "2. Create or update wiki pages following .schema.md conventions:",
    "   - Entity pages → entities/ (one per person, project, tool, service)",
    "   - Concept pages → concepts/ (ideas, patterns, architectural decisions)",
    `   - Session summary → sessions/${thread.state.source}/ (one per ingested transcript)`,
    "   - Comparisons → comparisons/ (only when two things are explicitly compared)",
    "   - Every page starts with YAML frontmatter: title, type, tags, updated_at, sources",
    "   - Cross-link pages with [[../entities/page-name]] or [[page-name]] wikilinks",
    "   - Update existing pages rather than creating duplicates",
    "",
    "3. Update index.md and append to log.md.",
    "4. Update overview.md and synthesis.md if new information shifts the big picture.",
    "",
    "5. Be thorough. A single conversation can contain many entities, concepts, and decisions.",
    "   A thin page with frontmatter and one sentence is better than no page.",
    "",
    "Now execute: read the wiki files you need, then write all new and updated files.",
    "Write actual markdown files — do not just output a plan.",
    ATOMIC_WRITE_NOTE,
  ].join("\n");
}

export function buildBatchedIngestPrompt(cfg: AppConfig): string {
  const wikiDir = cfg.paths.wikiDir;
  const schemaPath = path.join(wikiDir, ".schema.md");
  const indexPath = path.join(wikiDir, "index.md");
  const checkpointPath = path.join(cfg.paths.memoryDir, "checkpoint.json");
  const sessionsRoot = cfg.paths.sessions;

  return [
    "You maintain a personal, interlinked knowledge wiki.",
    "",
    `Wiki directory: ${wikiDir}`,
    `Thread directory: ${sessionsRoot}`,
    `Checkpoint file: ${checkpointPath}`,
    "",
    "## Preparation",
    `1. Read ${schemaPath} — wiki conventions: page format, YAML frontmatter, directory structure, cross-linking rules.`,
    `2. Read ${indexPath} — catalog of everything already in the wiki. Use it to avoid duplicate pages.`,
    "",
    "## Your task — ingest new conversations into the wiki",
    "",
    "1. Read the checkpoint file to see which threads have already been ingested.",
    "2. Browse the thread directory recursively — find all source folders and thread subdirectories.",
    "3. For each thread, read session.json to check last_event_at.",
    "4. A thread needs ingesting when BOTH conditions are met:",
    "   - Its last_event_at is newer than its checkpoint entry (checkpoint.threads[thread_key].lastIngestAt)",
    "   - Its last_event_at is more than 1 hour old (skip active conversations)",
    "5. For each qualifying thread:",
    "   - Read the full transcript",
    "   - Extract: entities, concepts, decisions, preferences, facts",
    "   - Create or update wiki pages following the conventions you read in .schema.md",
    "   - Update index.md and log.md",
    "6. Update overview.md and synthesis.md if new information shifts the big picture.",
    "7. Update checkpoint.json — set each ingested thread's lastIngestAt to its last_event_at.",
    "",
    "Be thorough. A thin page with frontmatter and one sentence is better than no page.",
    "Write actual markdown files — do not just output a plan.",
    ATOMIC_WRITE_NOTE,
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
