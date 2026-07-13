import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { parseAgentOutput, buildTurnPrompt } from "../src/core/harness-common.js";
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

  it("produces a minimal per-turn message with preceding events", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
    try {
      const prompt = await buildTurnPrompt(
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
          HARNESS: "codex",
          paths: buildWorkspacePaths("/workspace"),
        } as never,
        {
          thread: {
            dir: tmpDir,
            attachmentsDir: path.join(tmpDir, "attachments"),
            transcriptFile: path.join(tmpDir, "transcript.md"),
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
            allowed_permissions: ["deploy:read", "db:query.alpha"],
          },
          skills: [
            {
              id: "general",
              name: "general",
              description: "Default skill",
              permissions: [],
              path: path.join("/workspace/.agents/skills", "general", "SKILL.md"),
              body: "",
            },
            {
              id: "deploy",
              name: "deploy",
              description: "Deploy skill",
              permissions: ["deploy:read", "deploy:run"],
              path: path.join("/workspace/.agents/skills", "deploy", "SKILL.md"),
              body: "",
            },
            {
              id: "db",
              name: "db",
              description: "Scoped-permission skill",
              permissions: ["db:query.*", "db:admin.*"],
              path: path.join("/workspace/.agents/skills", "db", "SKILL.md"),
              body: "",
            },
          ],
          sourceContext: {
            behaviorInstructions: [
              "9. For Mattermost channel threads (visibility: channel), only answer when the post explicitly mentions @felix-agent or @Felix Agent. If not mentioned, output nothing — no FELIX_REPLY, no explanation. In DMs (visibility: dm), answer normally regardless of mention.",
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
      );

      // Resolved paths the model can't derive are injected
      expect(prompt).toContain(`thread_dir: ${tmpDir}`);
      expect(prompt).toContain(`initial_md: ${path.join(tmpDir, "INITIAL.md")}`);
      expect(prompt).toContain(`transcript: ${path.join(tmpDir, "transcript.md")}`);
      expect(prompt).toContain("contact_file: ");
      expect(prompt).toContain(path.join("catalog", "contacts", "mattermost", "user.md"));

      // Per-turn message contains the new event
      expect(prompt).toContain("event_file: /workspace/records/sessions/mattermost/thread/events/event.md");
      expect(prompt).toContain("visibility: channel");
      expect(prompt).toContain("mentions_bot: true");
      expect(prompt).toContain("sender: mattermost:user");
      expect(prompt).toContain("text: Hello");

      // Server-computed permission gate is injected and authoritative
      expect(prompt).toContain("permissions_per_skill (server-computed — authoritative");
      expect(prompt).toContain("deploy: have=[read], need=[run]");
      // Skills with no permissions are not listed in the gate
      expect(prompt).not.toContain("general: have=");
      // Scoped declarations: have lists the contact's concrete grants; a name with
      // zero grants stays in need as the declared wildcard form
      expect(prompt).toContain("db: have=[query.alpha], need=[admin.*]");
      expect(prompt).toContain("Scoped permissions (name.<scope>)");

      // Preceding events are included
      expect(prompt).toContain("preceding (already in transcript):");
      expect(prompt).toContain("event_file: /workspace/records/sessions/mattermost/thread/events/pre-1.md");
      expect(prompt).toContain("event_file: /workspace/records/sessions/mattermost/thread/events/pre-2.md");

      // Attachments in preceding events
      expect(prompt).toContain("report.pdf (application/pdf)");
      expect(prompt).toContain("huge.zip [rejected: File is 30.0 MiB, above the 25.0 MiB limit.]");

      // No old template remnants
      expect(prompt).not.toContain("{{");
      expect(prompt).not.toContain("Permission Model");
      expect(prompt).not.toContain("Guardrails");
      expect(prompt).not.toContain("Output Format");

      // INITIAL.md was written
      const { readFile } = await import("node:fs/promises");
      const initialContent = await readFile(path.join(tmpDir, "INITIAL.md"), "utf-8");
      expect(initialContent).toContain("Session ID");
      expect(initialContent).toContain("session-1");
      expect(initialContent).toContain("Platform Instructions");
      expect(initialContent).toContain("only answer when the post explicitly mentions @felix-agent");
      // Owner identity / permission state are not injected into INITIAL.md
      expect(initialContent).not.toContain("## Owner");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("produces a minimal per-turn message on resumed turns", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
    try {
      const prompt = await buildTurnPrompt(
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
          HARNESS: "codex",
          paths: buildWorkspacePaths("/workspace"),
        } as never,
        {
          thread: {
            dir: tmpDir,
            attachmentsDir: path.join(tmpDir, "attachments"),
            transcriptFile: path.join(tmpDir, "transcript.md"),
          } as never,
          event: {
            source: "mattermost",
            thread_key: "mattermost:channel:root",
            sender: { source: "mattermost", id: "user" },
            text: "Check deploy status",
            attachments: [],
            event_id: "evt-2",
            received_at: "2026-05-25T01:00:00.000Z",
            visibility: "channel",
            mentions_bot: true,
            raw_path: "/workspace/intake/mattermost/raw/event.json",
            source_thread_ref: mattermostThreadRef("channel", "root", "evt-2"),
          },
          eventFile: "/workspace/records/sessions/mattermost/thread/events/event-2.md",
          contact: {
            source: "mattermost",
            user_id: "user",
            allowed_permissions: [],
          },
          // Bare-permission skill only: the permission gate must render without
          // the scoped-permissions preamble (it is gated on a `name.*` declaration).
          skills: [
            {
              id: "deploy",
              name: "deploy",
              description: "Deploy skill",
              permissions: ["deploy:read"],
              path: path.join("/workspace/.agents/skills", "deploy", "SKILL.md"),
              body: "",
            },
          ],
          sourceContext: { behaviorInstructions: [] },
          resumed: true,
        },
        "session-resumed",
      );

      // Minimal per-turn message
      expect(prompt).toContain("event_file: /workspace/records/sessions/mattermost/thread/events/event-2.md");
      expect(prompt).toContain("visibility: channel");
      expect(prompt).toContain("sender: mattermost:user");
      expect(prompt).toContain("text: Check deploy status");
      expect(prompt).not.toContain("{{");
      // Permission gate present, but no scoped preamble without a `name.*` declaration
      expect(prompt).toContain("deploy: have=[none], need=[read]");
      expect(prompt).not.toContain("Scoped permissions (name.<scope>)");
      expect(prompt).not.toContain("Permission Model");
      expect(prompt).not.toContain("Guardrails");
      expect(prompt).not.toContain("Output Format");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
