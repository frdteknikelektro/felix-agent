import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildThreadLink, createMattermostAdapter, isDirectMessageChannelType, mattermostSourceThreadRef, mattermostThreadKey, startMattermostSource } from "../src/adapters/mattermost/index.js";
import { mattermostMentionToken, mattermostMentionTokens } from "../src/adapters/mattermost/mentions.js";
import type { UniversalEvent } from "../src/types.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";
import type { FelixEngine } from "../src/engine.js";
import type { SourceAdapter } from "../src/core/ports.js";

describe("Mattermost source lifecycle", () => {
  it("starts the already-registered adapter instance", async () => {
    const cfg = await makeTestConfig("felix-mm-shared-");
    const lifecycle = { stop: vi.fn(), done: Promise.resolve() };
    const start = vi.fn().mockResolvedValue(lifecycle);
    const adapter = { source: "mattermost", start } as unknown as SourceAdapter;
    const engine = {} as FelixEngine;

    await expect(startMattermostSource(cfg, engine, adapter)).resolves.toBe(lifecycle);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(engine);
  });
});

describe("Mattermost mention token", () => {
  it("normalizes the canonical bot username into an @mention token", () => {
    expect(mattermostMentionToken("felix-agent")).toBe("@felix-agent");
    expect(mattermostMentionToken("@felix-agent")).toBe("@felix-agent");
    expect(mattermostMentionTokens("felix-agent", "Felix Agent")).toEqual(["@felix-agent", "@Felix Agent"]);
  });

  it("treats only direct message channels as dm visibility", () => {
    expect(isDirectMessageChannelType("D")).toBe(true);
    expect(isDirectMessageChannelType("G")).toBe(false);
    expect(isDirectMessageChannelType("P")).toBe(false);
    expect(isDirectMessageChannelType("O")).toBe(false);
  });
});

describe("Mattermost thread identity", () => {
  it("uses channel id and root post id for the adapter-owned thread key", () => {
    expect(mattermostThreadKey("channel-1", "root-post-1")).toBe("mattermost:channel-1:root-post-1");
  });

  it("maps Mattermost fields into a source-neutral thread ref", () => {
    expect(mattermostSourceThreadRef("channel-1", "root-post-1", "reply-post-2", "user-1", "team-1")).toEqual({
      source: "mattermost",
      conversation_id: "channel-1",
      thread_id: "root-post-1",
      root_message_id: "root-post-1",
      message_id: "reply-post-2",
      team_id: "team-1",
      raw: {
        channel_id: "channel-1",
        root_id: "root-post-1",
        user_id: "user-1",
      },
    });
  });
});

describe("buildThreadLink", () => {
  it("includes team slug when provided", () => {
    expect(buildThreadLink("https://mattermost.jala.tech", "xida8bxtwpg6ifpad1w4zqpofh", "jala")).toBe(
      "https://mattermost.jala.tech/jala/pl/xida8bxtwpg6ifpad1w4zqpofh",
    );
  });

  it("uses _redirect/pl for DMs (no team slug)", () => {
    expect(buildThreadLink("https://mattermost.jala.tech", "xida8bxtwpg6ifpad1w4zqpofh")).toBe(
      "https://mattermost.jala.tech/_redirect/pl/xida8bxtwpg6ifpad1w4zqpofh",
    );
  });

  it("strips trailing slash from base URL", () => {
    expect(buildThreadLink("https://mattermost.jala.tech/", "abc123", "jala")).toBe(
      "https://mattermost.jala.tech/jala/pl/abc123",
    );
  });
});

describe("Mattermost attachment download", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function attachmentEvent(): UniversalEvent {
    return {
      source: "mattermost",
      event_id: "post-1",
      thread_key: "mattermost:channel:root",
      received_at: "2026-06-28T00:00:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "user" },
      text: "look",
      attachments: [{ file_id: "file-abc", filename: "file-abc" }],
      raw_path: "",
      source_thread_ref: mattermostThreadRef("channel", "root", "post-1"),
    };
  }

  it("fetches metadata from /info and the file body without a /download suffix", async () => {
    const cfg = await makeTestConfig("felix-mm-dl-", {
      MATTERMOST_URL: "https://mm.example.com",
      MATTERMOST_BOT_TOKEN: "tok",
    });
    const adapter = createMattermostAdapter(cfg);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-mm-dest-"));
    const calls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.endsWith("/info")) {
        return new Response(
          JSON.stringify({ name: "cat.png", mime_type: "image/png", size: 3 }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(Buffer.from("PNG"), {
        headers: { "content-length": "3", "content-type": "image/png" },
      });
    }) as typeof fetch;

    const result = await adapter.downloadAttachment({
      event: attachmentEvent(),
      attachment: { file_id: "file-abc", filename: "file-abc" },
      destinationDir: dir,
      maxBytes: 25 * 1024 * 1024,
    });

    expect(calls).toContain("https://mm.example.com/api/v4/files/file-abc/info");
    expect(calls).toContain("https://mm.example.com/api/v4/files/file-abc");
    expect(calls).not.toContain("https://mm.example.com/api/v4/files/file-abc/download");
    expect(result.status).toBe("available");
    expect(result.filename).toBe("cat.png");
    expect(result.content_type).toBe("image/png");
    expect(result.is_image).toBe(true);
    expect(result.size_bytes).toBe(3);
    const body = await fs.readFile(result.local_path!, "utf8");
    expect(body).toBe("PNG");
  });
});

describe("Mattermost source turn context", () => {
  it("derives bot identity from /users/me and does not rewrite configuration", async () => {
    const cfg = await makeTestConfig("felix-mm-api-identity-", {
      MATTERMOST_URL: "https://mm.example.com",
      MATTERMOST_BOT_TOKEN: "token",
      MATTERMOST_BOT_USER_ID: "legacy-id",
      MATTERMOST_BOT_USERNAME: "legacy-name",
    });
    const adapter = createMattermostAdapter(cfg);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "api-id", username: "api-name", display_name: "API Name" }));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const context = await adapter.getTurnContext({
        event: {
          source: "mattermost", event_id: "api-event", thread_key: "mattermost:c:r",
          received_at: "2026-05-25T00:00:00.000Z", visibility: "channel", mentions_bot: true,
          sender: { source: "mattermost", id: "user" }, text: "hello", attachments: [], raw_path: "",
          source_thread_ref: mattermostThreadRef("c", "r", "api-event"),
        },
      });
      expect(adapter.botUserId).toBe("api-id");
      expect(cfg.MATTERMOST_BOT_USER_ID).toBe("legacy-id");
      expect(context.behaviorInstructions[1]).toContain("@api-name");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves the owner display from the configured owner ID", async () => {
    const cfg = await makeTestConfig("felix-mm-owner-api-", {
      MATTERMOST_URL: "https://mm.example.com",
      MATTERMOST_BOT_TOKEN: "token",
      MATTERMOST_OWNER_USER_ID: "owner-id",
      MATTERMOST_OWNER_DISPLAY: "Legacy Owner",
    });
    const adapter = createMattermostAdapter(cfg);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v4/users/me")) return new Response(JSON.stringify({ id: "bot-id", username: "bot" }));
      if (url.endsWith("/api/v4/users/owner-id")) return new Response(JSON.stringify({ username: "owner", display_name: "API Owner" }));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      await adapter.getTurnContext({
        event: {
          source: "mattermost", event_id: "owner-api-event", thread_key: "mattermost:c:r",
          received_at: "2026-05-25T00:00:00.000Z", visibility: "channel", mentions_bot: true,
          sender: { source: "mattermost", id: "user" }, text: "hello", attachments: [], raw_path: "",
          source_thread_ref: mattermostThreadRef("c", "r", "owner-api-event"),
        },
      });
      expect(adapter.ownerDisplay).toBe("API Owner");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks a malformed successful identity response as legacy fallback", async () => {
    const cfg = await makeTestConfig("felix-mm-malformed-identity-", {
      MATTERMOST_URL: "https://mm.example.com",
      MATTERMOST_BOT_TOKEN: "token",
      MATTERMOST_BOT_USER_ID: "legacy-id",
    });
    const adapter = createMattermostAdapter(cfg);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not-json")) as typeof fetch;
    try {
      await adapter.getTurnContext({
        event: {
          source: "mattermost", event_id: "malformed-event", thread_key: "mattermost:c:r",
          received_at: "2026-05-25T00:00:00.000Z", visibility: "channel", mentions_bot: true,
          sender: { source: "mattermost", id: "user" }, text: "hello", attachments: [], raw_path: "",
          source_thread_ref: mattermostThreadRef("c", "r", "malformed-event"),
        },
      });
      expect(adapter.botIdentity?.source).toBe("legacy");
      expect(adapter.botIdentity?.discovered).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the configured agent name when no Mattermost identity is set", async () => {
    const cfg = await makeTestConfig("felix-mm-name-", {
      FELIX_NAME: "Nova",
      MATTERMOST_BOT_DISPLAY: "",
    });
    const adapter = createMattermostAdapter(cfg);

    const context = await adapter.getTurnContext({
      event: {
        source: "mattermost",
        event_id: "reply-post",
        thread_key: "mattermost:channel:root-post",
        received_at: "2026-05-25T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "mattermost", id: "user" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: mattermostThreadRef("channel", "root-post", "reply-post"),
      },
    });

    expect(context.behaviorInstructions[1]).toContain("@Nova");
  });

  it("owns Mattermost-specific prompt instructions", async () => {
    const cfg = await makeTestConfig("felix-mm-context-", {
      MATTERMOST_BOT_USERNAME: "felix-agent",
      MATTERMOST_BOT_DISPLAY: "Felix Agent",
    });
    const adapter = createMattermostAdapter(cfg);

    const context = await adapter.getTurnContext({
      event: {
        source: "mattermost",
        event_id: "reply-post",
        thread_key: "mattermost:channel:root-post",
        received_at: "2026-05-25T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "mattermost", id: "user" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: mattermostThreadRef("channel", "root-post", "reply-post"),
      },
    });

    const text = context.behaviorInstructions.join("\n");
    expect(text).toContain("@felix-agent or @Felix Agent");
    expect(text).toContain('THREAD_POST_ID="root-post"');
    expect(text).toContain("/api/v4/posts/$THREAD_POST_ID/thread");
    expect(text).toContain("M3. Mattermost API posting");
    expect(text).not.toContain("source /run/secrets/.env");
    expect(text).toContain("MATTERMOST_URL");
    expect(text).toContain("MATTERMOST_BOT_TOKEN");
    expect(text).toContain('MATTERMOST_CHANNEL_ID="channel"');
    expect(text).toContain('MATTERMOST_ROOT_POST_ID="root-post"');
    expect(text).toContain("export MATTERMOST_CHANNEL_ID MATTERMOST_ROOT_POST_ID");
    expect(text).toContain("POST /api/v4/posts");
    expect(text).toContain("POST /api/v4/files");
    expect(text).toContain("file_ids");
    expect(text).toContain("export FILE_ID");
    expect(text).toContain("root_id");
    expect(text).toContain("files=@${ARTIFACT_PATH}");
    // Audio instructions live in skills/listen-speak/SKILL.md (covered by listen-speak-skill.test.ts); src/AGENTS.md points there.
  });

  it("instructs mentioning the owner when an owner username is configured", async () => {
    const cfg = await makeTestConfig("felix-mm-owner-", {
      MATTERMOST_OWNER_USERNAME: "farid",
    });
    const adapter = createMattermostAdapter(cfg);

    const context = await adapter.getTurnContext({
      event: {
        source: "mattermost",
        event_id: "reply-post",
        thread_key: "mattermost:channel:root-post",
        received_at: "2026-05-25T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "mattermost", id: "user" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: mattermostThreadRef("channel", "root-post", "reply-post"),
      },
    });

    const text = context.behaviorInstructions.join("\n");
    expect(text).toContain("PERMISSION_REQUIRED");
    expect(text).toContain("@farid");
  });

  it("does not instruct an owner mention when only the (defaulted) display name is set", async () => {
    const cfg = await makeTestConfig("felix-mm-no-owner-");
    const adapter = createMattermostAdapter(cfg);

    const context = await adapter.getTurnContext({
      event: {
        source: "mattermost",
        event_id: "reply-post",
        thread_key: "mattermost:channel:root-post",
        received_at: "2026-05-25T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "mattermost", id: "user" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: mattermostThreadRef("channel", "root-post", "reply-post"),
      },
    });

    const text = context.behaviorInstructions.join("\n");
    expect(text).not.toContain("@Owner");
    expect(text).not.toContain("PERMISSION_REQUIRED");
  });
});
