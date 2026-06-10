import { describe, expect, it } from "vitest";
import { buildThreadLink, createMattermostAdapter, isDirectMessageChannelType, mattermostMentionToken, mattermostMentionTokens, mattermostSourceThreadRef, mattermostThreadKey } from "../src/adapters/mattermost/index.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

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

describe("Mattermost source turn context", () => {
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

    expect(context.owner).toBeUndefined();

    const text = context.behaviorInstructions.join("\n");
    expect(text).toContain("@felix-agent or @Felix Agent");
    expect(text).toContain('THREAD_POST_ID="root-post"');
    expect(text).toContain("/api/v4/posts/$THREAD_POST_ID/thread");
    expect(text).toContain("Source API posting for Mattermost");
    expect(text).toContain("post them directly to the current Mattermost thread");
    expect(text).not.toContain("source /run/secrets/.env");
    expect(text).toContain("MATTERMOST_URL");
    expect(text).toContain("MATTERMOST_TOKEN");
    expect(text).toContain('MATTERMOST_CHANNEL_ID="channel"');
    expect(text).toContain('MATTERMOST_ROOT_POST_ID="root-post"');
    expect(text).toContain("export MATTERMOST_CHANNEL_ID MATTERMOST_ROOT_POST_ID");
    expect(text).toContain("POST /api/v4/posts");
    expect(text).toContain("POST /api/v4/files");
    expect(text).toContain("file_ids");
    expect(text).toContain("export FILE_ID");
    expect(text).toContain("root_id");
    expect(text).toContain("files=@${ARTIFACT_PATH}");
    expect(text).toContain("only for files generated for this current session/request");
    expect(text).toContain("Never upload secrets, credential files, raw env files");
    expect(text).toContain("final FELIX_REPLY should be concise and mention what was posted");
  });
});
