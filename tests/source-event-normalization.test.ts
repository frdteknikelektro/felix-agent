import { describe, expect, it } from "vitest";
import {
  normalizeSourceEvent,
  sourceThreadKey,
  sourceThreadRef,
} from "../src/core/source-event-normalization.js";

describe("source event normalization", () => {
  it("formats the source-owned thread key consistently", () => {
    expect(sourceThreadKey("slack", "C123", "1234.5678")).toBe("slack:C123:1234.5678");
  });

  it("builds the source-neutral thread ref with source raw fields preserved", () => {
    expect(sourceThreadRef({
      source: "mattermost",
      conversationId: "channel-1",
      rootMessageId: "root-post",
      messageId: "reply-post",
      sourceTeamId: "team-1",
      raw: {
        channel_id: "channel-1",
        root_id: "root-post",
        user_id: "user-1",
      },
    })).toEqual({
      source: "mattermost",
      conversation_id: "channel-1",
      thread_id: "root-post",
      root_message_id: "root-post",
      message_id: "reply-post",
      team_id: "team-1",
      raw: {
        channel_id: "channel-1",
        root_id: "root-post",
        user_id: "user-1",
      },
    });
  });

  it("assembles a UniversalEvent from source facts", () => {
    const event = normalizeSourceEvent({
      source: "discord",
      eventId: "message-1",
      receivedAt: "2026-06-01T00:00:00.000Z",
      visibility: "channel",
      mentionsBot: true,
      sender: { source: "discord", id: "user-1", username: "alice" },
      text: "hello",
      attachments: [{ file_id: "file-1", filename: "image.png", is_image: true }],
      thread: {
        source: "discord",
        conversationId: "channel-1",
        rootMessageId: "root-1",
        messageId: "message-1",
        raw: {
          channel_id: "channel-1",
          root_id: "root-1",
          user_id: "user-1",
        },
      },
    });

    expect(event).toMatchObject({
      source: "discord",
      event_id: "message-1",
      thread_key: "discord:channel-1:root-1",
      received_at: "2026-06-01T00:00:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "discord", id: "user-1", username: "alice" },
      text: "hello",
      raw_path: "",
      source_thread_ref: {
        source: "discord",
        conversation_id: "channel-1",
        root_message_id: "root-1",
        message_id: "message-1",
      },
    });
    expect(event.attachments).toEqual([{ file_id: "file-1", filename: "image.png", is_image: true }]);
  });
});
