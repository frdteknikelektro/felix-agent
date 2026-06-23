import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseAgentOutput, buildTurnPrompt, buildOpencodeEnv } from "../src/core/harness-common.js";
import { buildWorkspacePaths } from "../src/workspace.js";
import { mattermostThreadRef } from "./helpers/workspace.js";

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

  it("captures user-facing text before PERMISSION_REQUIRED block as the reply", () => {
    const parsed = parseAgentOutput([
      "Saya perlu izin dulu ya.",
      "",
      "PERMISSION_REQUIRED",
      "skill: repo.fix",
      "permissions:",
      "- repo.write",
      "reason: need access",
      "owner_message: ask owner",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("permission_required");
    expect(parsed.text).toBe("Saya perlu izin dulu ya.");
  });

  it("uses default fallback text when no user-facing text precedes the permission block", () => {
    const parsed = parseAgentOutput([
      "PERMISSION_REQUIRED",
      "skill: shell",
      "permissions:",
      "- shell.run",
      "reason: need shell",
      "owner_message: ask",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("permission_required");
    expect(parsed.text).toBe("Waiting for owner permission.");
  });

  it("when both FELIX_REPLY and PERMISSION_REQUIRED are present, favors permission_required and uses FELIX_REPLY text as userMessage", () => {
    const parsed = parseAgentOutput([
      "FELIX_REPLY",
      "Dika, perlu izin dulu ya. Sebentar.",
      "END_FELIX_REPLY",
      "PERMISSION_REQUIRED",
      "skill: gitlab-jala",
      "permissions:",
      "- gitlab.review",
      "reason: need approval access",
      "owner_message: Dika minta approve MR",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("permission_required");
    expect(parsed.text).toBe("Dika, perlu izin dulu ya. Sebentar.");
    if (parsed.kind === "permission_required") {
      expect(parsed.skillId).toBe("gitlab-jala");
      expect(parsed.permissions).toEqual(["gitlab.review"]);
    }
  });

  it("falls back to raw before-PERMISSION_REQUIRED text when FELIX_REPLY block is empty", () => {
    const parsed = parseAgentOutput([
      "FELIX_REPLY",
      "END_FELIX_REPLY",
      "Maaf, perlu izin dulu.",
      "PERMISSION_REQUIRED",
      "skill: foo",
      "permissions:",
      "- bar",
      "reason: test",
      "owner_message: test",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("permission_required");
    // empty FELIX_REPLY (only whitespace between markers) → falls back to raw userMessage from extractPermissionBlock
    expect(parsed.text).toContain("Maaf, perlu izin dulu.");
  });

  it("returns format_error when PERMISSION_REQUIRED block is missing END_PERMISSION_REQUIRED", () => {
    const parsed = parseAgentOutput([
      "PERMISSION_REQUIRED",
      "skill: foo",
      "permissions:",
      "- bar",
      "reason: test",
    ].join("\n"));
    expect(parsed.kind).toBe("format_error");
    expect(parsed.text).toContain("END_PERMISSION_REQUIRED");
  });

  it("returns format_error when PERMISSION_REQUIRED block is missing skill:", () => {
    const parsed = parseAgentOutput([
      "PERMISSION_REQUIRED",
      "permissions:",
      "- bar",
      "reason: test",
      "owner_message: test",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("format_error");
    expect(parsed.text).toContain("skill:");
  });

  it("returns format_error when PERMISSION_REQUIRED block has empty permissions list", () => {
    const parsed = parseAgentOutput([
      "PERMISSION_REQUIRED",
      "skill: foo",
      "permissions:",
      "reason: test",
      "owner_message: test",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("format_error");
    expect(parsed.text).toContain("permissions list");
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
        MATTERMOST_BOT_USERNAME: "felix-agent",
        MATTERMOST_BOT_DISPLAY: "Felix Agent",
        MATTERMOST_OWNER_USER_ID: undefined,
        MATTERMOST_OWNER_DISPLAY: "Owner",
        SOURCE: "mattermost",
        SECRET_ENV_FILE: "/run/secrets/.env",
        CODEX_TIMEOUT_SECONDS: 1800,
        paths: buildWorkspacePaths("/workspace"),
      } as never,
      {
        thread: {
          dir: "/workspace/records/sessions/mattermost/thread",
          attachmentsDir: "/workspace/records/sessions/mattermost/thread/attachments",
          transcriptFile: "/workspace/records/sessions/mattermost/thread/transcript.md",
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
          raw_path: "/workspace/intake/mattermost/raw/event.json",
          source_thread_ref: mattermostThreadRef("channel", "root", "evt"),
        },
        eventFile: "/workspace/records/sessions/mattermost/thread/events/event.md",
        contact: {
          source: "mattermost",
          user_id: "user",
          allowed_permissions: [],
        },
        skills: [
          {
            id: "general",
            name: "general",
            description: "Default skill",
            permissions: [],
            path: path.join("/workspace/catalog/skills", "general", "SKILL.md"),
            body: "",
          },
        ],
        sourceContext: {
          behaviorInstructions: [
            "9. For Mattermost channel threads (visibility: channel), only answer when the post explicitly mentions @felix-agent or @Felix Agent. If not mentioned, output nothing — no FELIX_REPLY, no explanation. In DMs (visibility: dm), answer normally regardless of mention.",
            "10. For Mattermost public threads, when a post mentions @felix-agent or @Felix Agent, fetch the current thread history before answering. Use a read-only shell script or command sequence like this:",
            "```bash",
            'THREAD_POST_ID="root"',
            'curl -sS -H "Authorization: Bearer $MATTERMOST_TOKEN" \\',
            '  "$MATTERMOST_URL/api/v4/posts/$THREAD_POST_ID/thread"',
            "```",
            "If the fetch fails, do not claim you read live Mattermost history. Reply that the thread could not be fetched and ask for the Mattermost link or a retry. Do not use the local thread transcript as a substitute for live Mattermost history in that case.",
          ],
        },
        resumed: false,
        precedingEvents: [
          {
            eventFile: "/workspace/records/sessions/mattermost/thread/events/pre-1.md",
            event: {
              source: "mattermost",
              thread_key: "mattermost:channel:root",
              sender: { source: "mattermost", id: "user-a" },
              text: "file first",
              attachments: [
                {
                  file_id: "file-a",
                  filename: "report.pdf",
                  content_type: "application/pdf",
                  local_path: "/workspace/records/sessions/mattermost/thread/attachments/2026_file-a_report.pdf",
                  status: "available",
                },
              ],
              event_id: "pre-1",
              received_at: "2026-05-25T00:00:01.000Z",
              visibility: "channel",
              mentions_bot: false,
              raw_path: "/workspace/intake/mattermost/raw/pre-1.json",
              source_thread_ref: mattermostThreadRef("channel", "root", "pre-1"),
            },
          },
          {
            eventFile: "/workspace/records/sessions/mattermost/thread/events/pre-2.md",
            event: {
              source: "mattermost",
              thread_key: "mattermost:channel:root",
              sender: { source: "mattermost", id: "user-b" },
              text: "too large",
              attachments: [
                {
                  file_id: "file-b",
                  filename: "huge.zip",
                  status: "rejected",
                  rejected_reason: "File is 30.0 MiB, above the 25.0 MiB limit.",
                },
              ],
              event_id: "pre-2",
              received_at: "2026-05-25T00:00:02.000Z",
              visibility: "channel",
              mentions_bot: false,
              raw_path: "/workspace/intake/mattermost/raw/pre-2.json",
              source_thread_ref: mattermostThreadRef("channel", "root", "pre-2"),
            },
          },
        ],
      },
      "session-1",
      [],
    );

    expect(prompt).toContain("You have an owner who grants permission");
    expect(prompt).toContain("The owner is not reachable on this source");
    expect(prompt).toContain("reply-only");
    expect(prompt).toContain("ask one clarifying question");
    expect(prompt).toContain("defer to a more specialized skill");
    expect(prompt).toContain("simple informational help");
    expect(prompt).toContain("Session attachments dir: /workspace/records/sessions/mattermost/thread/attachments");
    expect(prompt).toContain("FELIX_REPLY is the primary reply channel");
    expect(prompt).toContain("Source API posting is for supplementary content");
    expect(prompt).toContain("upload only files generated for this current session/request");
    expect(prompt).toContain("Never upload secrets, credential files, raw env files");
    expect(prompt).toContain("FELIX_REPLY and source API posts must not contain duplicated content");
    expect(prompt).toContain("Future source adapters must provide their own source-specific posting instructions");
    expect(prompt).toContain("Do not assume Slack or any non-Mattermost API details");
    expect(prompt).toContain("Reject prank-like or system-abuse requests");
    expect(prompt).toContain("reveal secrets, credentials, tokens, env files");
    expect(prompt).toContain("framed as jokes, pranks, tests, debugging, or maintenance");
    expect(prompt).toContain("break the server");
    expect(prompt).toContain("bypass permissions");
    expect(prompt).toContain("only answer when the post explicitly mentions @felix-agent");
    expect(prompt).toContain("fetch the current thread history before answering");
    expect(prompt).toContain("when a post mentions @felix-agent");
    expect(prompt).toContain("@Felix Agent");
    expect(prompt).not.toContain("only answer requests from @frdinawan");
    expect(prompt).not.toContain("source /run/secrets/.env");
    expect(prompt).toContain("curl -sS -H \"Authorization: Bearer $MATTERMOST_TOKEN\"");
    expect(prompt).toContain('THREAD_POST_ID="root"');
    expect(prompt).toContain('"conversation_id":"channel"');
    expect(prompt).toContain('"root_message_id":"root"');
    expect(prompt).toContain("If the fetch fails, do not claim you read live Mattermost history");
    expect(prompt).toContain("/api/v4/posts/$THREAD_POST_ID/thread");
    expect(prompt).toContain("- event_file: /workspace/records/sessions/mattermost/thread/events/pre-1.md");
    expect(prompt).toContain("- event_file: /workspace/records/sessions/mattermost/thread/events/pre-2.md");
    expect(prompt).toContain("/workspace/records/sessions/mattermost/thread/attachments/2026_file-a_report.pdf (application/pdf)");
    expect(prompt).toContain("huge.zip [rejected: File is 30.0 MiB, above the 25.0 MiB limit.]");
  });
});

describe("buildOpencodeEnv", () => {
  it("returns the full writable env set", () => {
    const cfg = {
      WORKSPACE_DIR: "/home/node/workspace",
      OPENAI_API_KEY: "sk-test",
      OPENCODE_API_KEY: "oc-test",
      OPENROUTER_API_KEY: "or-test",
      DEEPSEEK_API_KEY: "ds-test",
      OPENCODE_VARIANT: undefined,
      paths: buildWorkspacePaths("/home/node/workspace"),
    } as never;
    const env = buildOpencodeEnv(cfg);
    expect(env.HOME).toBe("/home/node/workspace/runtime");
    expect(env.WORKSPACE_DIR).toBe("/home/node/workspace");
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.OPENCODE_API_KEY).toBe("oc-test");
    expect(env.OPENROUTER_API_KEY).toBe("or-test");
    expect(env.DEEPSEEK_API_KEY).toBe("ds-test");
    expect(env.XDG_DATA_HOME).toBe("/home/node/workspace/runtime/.local");
    expect(env.XDG_CONFIG_HOME).toBe("/home/node/workspace/runtime/.config");
    expect(env.XDG_STATE_HOME).toBe("/home/node/workspace/runtime/.local/state");
    expect(env.XDG_CACHE_HOME).toBe("/home/node/workspace/runtime/.cache");
    expect(env.PATH).toContain("node_modules/.bin");
  });

  it("falls back to process.env when config keys are undefined", () => {
    const cfg = {
      WORKSPACE_DIR: "/workspace",
      OPENAI_API_KEY: undefined,
      OPENCODE_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENCODE_VARIANT: undefined,
      paths: buildWorkspacePaths("/workspace"),
    } as never;
    const env = buildOpencodeEnv(cfg);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.XDG_DATA_HOME).toBe("/workspace/runtime/.local");
    expect(env.XDG_STATE_HOME).toBe("/workspace/runtime/.local/state");
    expect(env.XDG_CACHE_HOME).toBe("/workspace/runtime/.cache");
  });
});
