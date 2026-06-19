import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIngestPrompt, buildIngestTurnInput } from "../../src/slices/memory/ingest.js";
import type { AppConfig } from "../../src/config.js";
import { buildWorkspacePaths } from "../../src/workspace.js";
import type { ThreadHandle } from "../../src/slices/sessions/index.js";
import type { ThreadState, SessionState } from "../../src/types.js";

function makeConfig(dir = "/test-workspace"): AppConfig {
  return {
    WORKSPACE_DIR: dir,
    paths: buildWorkspacePaths(dir),
  } as unknown as AppConfig;
}

function makeThreadHandle(overrides: Partial<ThreadState> = {}): ThreadHandle {
  const dir = "/test-workspace/records/sessions/mattermost/2026-06-19_mattermost_c_m";
  const state: ThreadState = {
    thread_key: "mattermost:channel:msg",
    source: "mattermost",
    created_at: "2026-06-19T14:00:00Z",
    updated_at: "2026-06-19T14:00:00Z",
    managed_by_felix: true,
    source_thread_ref: {
      source: "mattermost",
      conversation_id: "channel",
      root_message_id: "msg",
    },
    participants: [],
    ...overrides,
  };
  const session: SessionState = {
    busy: false,
    queue: [],
    pending_permission: null,
  };
  return {
    dir,
    threadFile: path.join(dir, "thread.json"),
    sessionFile: path.join(dir, "session.json"),
    transcriptFile: path.join(dir, "transcript.md"),
    eventsDir: path.join(dir, "events"),
    attachmentsDir: path.join(dir, "attachments"),
    turnsDir: path.join(dir, "turns"),
    state,
    session,
  };
}

describe("memory ingest prompt", () => {
  it("includes wiki directory path in the prompt", () => {
    const cfg = makeConfig();
    const thread = makeThreadHandle();
    const prompt = buildIngestPrompt(cfg, thread, undefined);
    expect(prompt).toContain(cfg.paths.wikiDir);
    expect(prompt).toContain("entities/");
    expect(prompt).toContain("concepts/");
    expect(prompt).toContain("sessions/");
    expect(prompt).toContain("comparisons/");
  });

  it("includes thread metadata in the prompt", () => {
    const cfg = makeConfig("/workspace");
    const thread = makeThreadHandle();
    const prompt = buildIngestPrompt(cfg, thread, undefined);
    expect(prompt).toContain("mattermost");
    expect(prompt).toContain("mattermost:channel:msg");
    expect(prompt).toContain("overview.md");
    expect(prompt).toContain("synthesis.md");
    expect(prompt).toContain("YAML frontmatter");
  });

  it("includes checkpoint note when provided", () => {
    const cfg = makeConfig();
    const thread = makeThreadHandle();
    const prompt = buildIngestPrompt(cfg, thread, "2026-06-19T12:00:00Z");
    expect(prompt).toContain("2026-06-19T12:00:00Z");
    expect(prompt).toContain("Do not re-ingest older content");
  });

  it("builds turn input with promptOverride set", () => {
    const cfg = makeConfig();
    const thread = makeThreadHandle();
    const input = buildIngestTurnInput(cfg, thread, undefined);
    expect(input.promptOverride).toBeDefined();
    expect(input.promptOverride).toContain("Wiki directory");
    expect(input.resumed).toBe(false);
    expect(input.contact.user_id).toBe("memory-ingest");
    expect(input.skills).toEqual([]);
  });
});
