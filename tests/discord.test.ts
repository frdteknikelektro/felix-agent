import { describe, expect, it } from "vitest";
import { discordMentionToken } from "../src/adapters/discord/mentions.js";
import { createDiscordAdapter } from "../src/adapters/discord/index.js";
import { discordThreadKey, discordSourceThreadRef } from "../src/adapters/discord/index.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { SourceAdapter } from "../src/core/ports.js";

describe("discordMentionToken", () => {
  it("produces <@id> format", () => {
    expect(discordMentionToken("123456789")).toBe("<@123456789>");
  });

  it("returns undefined for empty input", () => {
    expect(discordMentionToken("")).toBeUndefined();
    expect(discordMentionToken(undefined)).toBeUndefined();
  });
});

describe("Discord API-derived identity", () => {
  it("captures the logged-in client ID and display identity on the real adapter", async () => {
    const cfg = await makeTestConfig("discord-api-identity-", { DISCORD_BOT_USER_ID: "legacy-id" });
    const adapter = createDiscordAdapter(cfg);
    (adapter as unknown as { client: { user: Record<string, unknown> } }).client = {
      user: { id: "api-id", username: "felix", globalName: "Felix Agent" },
    };
    expect(adapter.botIdentity).toEqual({
      userId: "api-id",
      username: "felix",
      displayName: "Felix Agent",
      source: "api",
      discovered: true,
    });
  });

  it("falls back to the legacy identity when no client is connected", async () => {
    const cfg = await makeTestConfig("discord-legacy-identity-", { DISCORD_BOT_USER_ID: "legacy-id" });
    expect(createDiscordAdapter(cfg).botIdentity).toMatchObject({
      userId: "legacy-id", source: "legacy", discovered: false,
    });
  });
});

describe("discordThreadKey", () => {
  it("formats as discord:channelId:rootId", () => {
    expect(discordThreadKey("chan-1", "root-2")).toBe("discord:chan-1:root-2");
  });
});

describe("discordSourceThreadRef", () => {
  it("builds correct ref with all fields", () => {
    const ref = discordSourceThreadRef({
      channelId: "chan-1",
      rootMessageId: "root-2",
      messageId: "msg-3",
      guildId: "guild-4",
      authorId: "user-5",
    });
    expect(ref.source).toBe("discord");
    expect(ref.conversation_id).toBe("chan-1");
    expect(ref.thread_id).toBe("root-2");
    expect(ref.root_message_id).toBe("root-2");
    expect(ref.message_id).toBe("msg-3");
    expect(ref.raw).toEqual({
      channel_id: "chan-1",
      root_id: "root-2",
      guild_id: "guild-4",
      user_id: "user-5",
    });
  });

  it("handles missing optional fields", () => {
    const ref = discordSourceThreadRef({
      channelId: "chan-1",
      rootMessageId: "root-2",
      messageId: "msg-3",
    });
    expect(ref.raw?.guild_id).toBeUndefined();
    expect(ref.raw?.user_id).toBeUndefined();
  });
});

describe("DiscordAdapter getTurnContext", () => {
  it("returns Discord-specific behavior instructions", async () => {
    const cfg = await makeTestConfig("discord-turnctx-");
    const adapter: SourceAdapter = createDiscordAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "discord",
        event_id: "evt-1",
        thread_key: "discord:chan-1:root-2",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "discord", id: "user-1" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: discordSourceThreadRef({
          channelId: "chan-1",
          rootMessageId: "root-2",
          messageId: "msg-3",
        }),
      },
    });

    expect(ctx.behaviorInstructions).toBeDefined();
    expect(ctx.behaviorInstructions.length).toBeGreaterThan(0);

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("Discord");
    expect(joined).toContain("CHANNEL_ID");
    expect(joined).toContain("discord.com");
    expect(joined).toContain("/api/v10/channels");
    expect(joined).toContain("DISCORD_BOT_TOKEN");
    expect(joined).toContain("2000");
    // Audio instructions live in skills/listen-speak/SKILL.md (covered by listen-speak-skill.test.ts); src/AGENTS.md points there.
  });

  it("instructs mentioning the owner when an owner user id is configured", async () => {
    const cfg = await makeTestConfig("discord-owner-", {
      DISCORD_OWNER_USER_ID: "999888777",
    });
    const adapter: SourceAdapter = createDiscordAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "discord",
        event_id: "evt-1",
        thread_key: "discord:chan-1:root-2",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "discord", id: "user-1" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: discordSourceThreadRef({
          channelId: "chan-1",
          rootMessageId: "root-2",
          messageId: "msg-3",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("PERMISSION_REQUIRED");
    expect(joined).toContain("<@999888777>");
  });

  it("does not instruct an owner mention when no owner user id is configured", async () => {
    const cfg = await makeTestConfig("discord-no-owner-");
    const adapter: SourceAdapter = createDiscordAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "discord",
        event_id: "evt-1",
        thread_key: "discord:chan-1:root-2",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "discord", id: "user-1" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: discordSourceThreadRef({
          channelId: "chan-1",
          rootMessageId: "root-2",
          messageId: "msg-3",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).not.toContain("PERMISSION_REQUIRED");
  });
});

describe("DiscordAdapter getThreadLink", () => {
  it("builds correct Discord URL for known guild", async () => {
    const cfg = await makeTestConfig("discord-link-");
    const adapter = createDiscordAdapter(cfg);
    const link = await adapter.getThreadLink("discord:chan-1:root-2");
    expect(link).toContain("discord.com/channels/@me/chan-1/root-2");
  });

  it("returns undefined for non-discord thread key", async () => {
    const cfg = await makeTestConfig("discord-link2-");
    const adapter = createDiscordAdapter(cfg);
    const link = await adapter.getThreadLink("mattermost:chan:root");
    expect(link).toBeUndefined();
  });
});

describe("DiscordAdapter source property", () => {
  it("identifies as discord", async () => {
    const cfg = await makeTestConfig("discord-src-");
    const adapter = createDiscordAdapter(cfg);
    expect(adapter.source).toBe("discord");
  });
});
