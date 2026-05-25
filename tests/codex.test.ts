import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseAgentOutput, buildTurnPrompt } from "../src/codex.js";

describe("codex output parser", () => {
  it("parses reply blocks", () => {
    const parsed = parseAgentOutput("FELIX_REPLY\nhello\nEND_FELIX_REPLY");
    expect(parsed.kind).toBe("reply");
    if (parsed.kind === "reply") {
      expect(parsed.text).toContain("hello");
    }
  });

  it("parses permission blocks", () => {
    const parsed = parseAgentOutput([
      "PERMISSION_REQUIRED",
      "skill: repo.fix",
      "permissions:",
      "- repo.write",
      "- shell.run",
      "reason: needs write access",
      "owner_message: ask owner",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("permission_required");
    if (parsed.kind === "permission_required") {
      expect(parsed.skillId).toBe("repo.fix");
      expect(parsed.permissions).toEqual(["repo.write", "shell.run"]);
    }
  });

  it("describes the general skill as a conservative fallback in the prompt", () => {
    const prompt = buildTurnPrompt(
      {
        WORKSPACE_DIR: "/workspace",
        CODEX_MODEL: "gpt-5.4-mini",
        CODEX_BIN: "codex",
        CODEX_BYPASS_SANDBOX: true,
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        OPENAI_ORGANIZATION: undefined,
        OPENAI_PROJECT: undefined,
        MATTERMOST_URL: undefined,
        MATTERMOST_TOKEN: undefined,
        MATTERMOST_BOT_USER_ID: undefined,
        MATTERMOST_BOT_USERNAME: undefined,
        MATTERMOST_BOT_DISPLAY: "Felix",
        MATTERMOST_OWNER_USER_ID: undefined,
        MATTERMOST_OWNER_DISPLAY: "Owner",
        SOURCE: "mattermost",
        THREAD_SCAN_INTERVAL_MS: 1000,
        CONFIG_DIR: "/config",
        SECRET_ENV_FILE: "/run/secrets/.env",
        HEALTH_PORT: 3000,
        CODEX_TIMEOUT_SECONDS: 1800,
        paths: {
          root: "/workspace",
          raw: "/workspace/raw",
          threads: "/workspace/threads",
          contacts: "/workspace/contacts",
          skills: "/workspace/skills",
          logs: "/workspace/logs",
          media: "/workspace/media",
          codex: "/workspace/codex",
          health: "/workspace/.health",
        },
      } as never,
      {
        thread: {
          dir: "/workspace/threads/thread",
          transcriptFile: "/workspace/threads/thread/transcript.md",
        } as never,
        event: {
          source: "mattermost",
          thread_key: "mattermost:channel:root",
          sender: { source: "mattermost", id: "user" },
          text: "Hello",
          attachments: [],
          event_id: "evt",
          received_at: "2026-05-25T00:00:00.000Z",
          visibility: "channel",
          mentions_bot: true,
          raw_path: "/workspace/raw/event.json",
          source_thread: { channel_id: "channel", root_id: "root" },
        },
        eventFile: "/workspace/threads/thread/events/event.md",
        contact: {
          source: "mattermost",
          user_id: "user",
          allowed_permissions: [],
          allowed_skills: [],
        },
        skills: [
          {
            id: "general",
            name: "general",
            description: "Default skill",
            permissions: [],
            path: path.join("/workspace/skills", "general", "SKILL.md"),
            body: "",
          },
        ],
        skillIndexPath: "/workspace/skills/index.md",
        permissionEvents: [],
        threadTranscriptPath: "/workspace/threads/thread/transcript.md",
        images: [],
        resumed: false,
      },
      "session-1",
    );

    expect(prompt).toContain("reply-only");
    expect(prompt).toContain("ask one clarifying question");
    expect(prompt).toContain("defer to a more specialized skill");
    expect(prompt).toContain("simple informational help");
  });
});
