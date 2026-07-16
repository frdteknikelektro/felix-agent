import { describe, expect, it, vi } from "vitest";
import { slackMentionToken } from "../src/adapters/slack/mentions.js";
import { createSlackAdapter, startSlackSource } from "../src/adapters/slack/index.js";
import { slackThreadKey, slackSourceThreadRef } from "../src/adapters/slack/index.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { SourceAdapter } from "../src/core/ports.js";
import type { FelixEngine } from "../src/engine.js";

describe("slackMentionToken", () => {
  it("produces <@id> format", () => {
    expect(slackMentionToken("U123")).toBe("<@U123>");
  });

  it("returns undefined for empty input", () => {
    expect(slackMentionToken("")).toBeUndefined();
    expect(slackMentionToken(undefined)).toBeUndefined();
  });
});

describe("Slack API-derived identity", () => {
  it("captures auth.test state on the real adapter", async () => {
    const cfg = await makeTestConfig("slack-api-identity-", { SLACK_BOT_USER_ID: "ULEGACY" });
    const adapter = createSlackAdapter(cfg);
    Object.assign(adapter, {
      discoveredBotUserId: "UAPI",
      discoveredBotUsername: "felix",
      discoveredBotDisplay: "Felix Agent",
    });
    expect(adapter.botIdentity).toEqual({
      userId: "UAPI",
      username: "felix",
      displayName: "Felix Agent",
      source: "api",
      discovered: true,
    });
  });

  it("falls back to the legacy identity before auth.test succeeds", async () => {
    const cfg = await makeTestConfig("slack-legacy-identity-", { SLACK_BOT_USER_ID: "ULEGACY" });
    expect(createSlackAdapter(cfg).botIdentity).toMatchObject({
      userId: "ULEGACY", source: "legacy", discovered: false,
    });
  });

  it("prefers the API-derived owner display over the legacy setting", async () => {
    const cfg = await makeTestConfig("slack-owner-display-", {
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_APP_TOKEN: "xapp-secret",
      SLACK_OWNER_USER_ID: "UOWNER123",
      SLACK_OWNER_DISPLAY: "Legacy Owner",
    });
    const fetchOwner = vi.fn(async () => ({
      user: {
        id: "UOWNER123",
        name: "owner",
        real_name: "Owner Name",
        profile: { display_name: "API Owner" },
      },
    }));
    const app = {
      client: {
        auth: {
          test: vi.fn(async () => ({
            user_id: "UFELIX",
            user: "felix",
            real_name: "Felix",
            url: "https://workspace.slack.com/",
          })),
        },
        users: { info: fetchOwner },
      },
      event: vi.fn(),
      error: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const adapter = createSlackAdapter(cfg, {
      createApp: () => app as never,
    });
    const lifecycle = await startSlackSource(cfg, {} as FelixEngine, adapter);

    expect(fetchOwner).toHaveBeenCalledWith({ user: "UOWNER123" });
    expect(adapter.ownerDisplay).toBe("API Owner");
    lifecycle.stop();
    await lifecycle.done;
    expect(app.stop).toHaveBeenCalledOnce();
  });

  it("falls back to the legacy owner display when API discovery fails", async () => {
    const cfg = await makeTestConfig("slack-owner-display-fallback-", {
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_APP_TOKEN: "xapp-secret",
      SLACK_OWNER_USER_ID: "UOWNER123",
      SLACK_OWNER_DISPLAY: "Legacy Owner",
    });
    const app = {
      client: {
        auth: {
          test: vi.fn(async () => ({
            user_id: "UFELIX",
            user: "felix",
            real_name: "Felix",
            url: "https://workspace.slack.com/",
          })),
        },
        users: { info: vi.fn(async () => { throw new Error("unavailable"); }) },
      },
      event: vi.fn(),
      error: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const adapter = createSlackAdapter(cfg, {
      createApp: () => app as never,
    });
    const lifecycle = await startSlackSource(cfg, {} as FelixEngine, adapter);

    expect(adapter.ownerDisplay).toBe("Legacy Owner");
    lifecycle.stop();
    await lifecycle.done;
  });
});

describe("slackThreadKey", () => {
  it("formats as slack:channelId:rootId", () => {
    expect(slackThreadKey("C123", "1234567890.123456")).toBe("slack:C123:1234567890.123456");
  });
});

describe("slackSourceThreadRef", () => {
  it("builds correct ref with all fields", () => {
    const ref = slackSourceThreadRef({
      channelId: "C123",
      rootMessageId: "1234567890.123456",
      messageId: "1234567891.654321",
      teamId: "T123",
      authorId: "U456",
    });
    expect(ref.source).toBe("slack");
    expect(ref.conversation_id).toBe("C123");
    expect(ref.thread_id).toBe("1234567890.123456");
    expect(ref.root_message_id).toBe("1234567890.123456");
    expect(ref.message_id).toBe("1234567891.654321");
    expect(ref.raw).toEqual({
      channel_id: "C123",
      root_id: "1234567890.123456",
      team_id: "T123",
      user_id: "U456",
    });
  });

  it("handles missing optional fields", () => {
    const ref = slackSourceThreadRef({
      channelId: "C123",
      rootMessageId: "1234.5678",
      messageId: "1234.9999",
    });
    expect(ref.raw?.team_id).toBeUndefined();
    expect(ref.raw?.user_id).toBeUndefined();
  });
});

describe("SlackAdapter getTurnContext", () => {
  it("returns Slack-specific behavior instructions", async () => {
    const cfg = await makeTestConfig("slack-turnctx-");
    const adapter: SourceAdapter = createSlackAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "slack",
        event_id: "evt-1",
        thread_key: "slack:C123:1234.5678",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "slack", id: "user-1" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: slackSourceThreadRef({
          channelId: "C123",
          rootMessageId: "1234.5678",
          messageId: "1234.9999",
        }),
      },
    });

    expect(ctx.behaviorInstructions).toBeDefined();
    expect(ctx.behaviorInstructions.length).toBeGreaterThan(0);

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("Slack");
    expect(joined).toContain("CHANNEL_ID");
    expect(joined).toContain("slack.com");
    expect(joined).toContain("SLACK_BOT_TOKEN");
    expect(joined).toContain("conversations.replies");
    expect(joined).toContain("chat.postMessage");
    // Audio instructions live in skills/listen-speak/SKILL.md (covered by listen-speak-skill.test.ts); src/AGENTS.md points there.
  });

  it("instructs mentioning the owner when an owner user id is configured", async () => {
    const cfg = await makeTestConfig("slack-owner-", {
      SLACK_OWNER_USER_ID: "U999",
    });
    const adapter: SourceAdapter = createSlackAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "slack",
        event_id: "evt-1",
        thread_key: "slack:C123:1234.5678",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "slack", id: "user-1" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: slackSourceThreadRef({
          channelId: "C123",
          rootMessageId: "1234.5678",
          messageId: "1234.9999",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("PERMISSION_REQUIRED");
    expect(joined).toContain("<@U999>");
  });

  it("does not instruct an owner mention when no owner user id is configured", async () => {
    const cfg = await makeTestConfig("slack-no-owner-");
    const adapter: SourceAdapter = createSlackAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "slack",
        event_id: "evt-1",
        thread_key: "slack:C123:1234.5678",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "slack", id: "user-1" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: slackSourceThreadRef({
          channelId: "C123",
          rootMessageId: "1234.5678",
          messageId: "1234.9999",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).not.toContain("PERMISSION_REQUIRED");
  });
});

describe("SlackAdapter getThreadLink", () => {
  it("builds correct Slack URL", async () => {
    const cfg = await makeTestConfig("slack-link-");
    const adapter = createSlackAdapter(cfg);
    const link = await adapter.getThreadLink("slack:C123:1234567890.123456");
    expect(link).toContain("slack.com/archives/C123/p1234567890123456");
  });

  it("returns undefined for non-slack thread key", async () => {
    const cfg = await makeTestConfig("slack-link2-");
    const adapter = createSlackAdapter(cfg);
    const link = await adapter.getThreadLink("discord:c:r");
    expect(link).toBeUndefined();
  });
});

describe("SlackAdapter source property", () => {
  it("identifies as slack", async () => {
    const cfg = await makeTestConfig("slack-src-");
    const adapter = createSlackAdapter(cfg);
    expect(adapter.source).toBe("slack");
  });
});
