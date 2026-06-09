import { describe, expect, it } from "vitest";
import { shouldAcceptEvent, isOwnMessage } from "../src/core/routing.js";
import type { UniversalEvent } from "../src/types.js";
import { mattermostThreadRef } from "./helpers/workspace.js";

function makeEvent(overrides: Partial<UniversalEvent> = {}): UniversalEvent {
  return {
    source: "mattermost",
    event_id: "evt-1",
    thread_key: "mattermost:c:r",
    received_at: "2026-05-30T00:00:00.000Z",
    visibility: "channel",
    mentions_bot: false,
    sender: { source: "mattermost", id: "user-1" },
    text: "hello",
    attachments: [],
    raw_path: "/tmp/evt.json",
    source_thread_ref: mattermostThreadRef("c", "r", "evt-1"),
    ...overrides,
  };
}

describe("shouldAcceptEvent", () => {
  it("accepts DMs regardless of mention", () => {
    expect(shouldAcceptEvent(makeEvent({ visibility: "dm", mentions_bot: false }))).toBe(true);
  });

  it("accepts channel posts that mention the bot", () => {
    expect(shouldAcceptEvent(makeEvent({ visibility: "channel", mentions_bot: true }))).toBe(true);
  });

  it("rejects channel posts without a mention", () => {
    expect(shouldAcceptEvent(makeEvent({ visibility: "channel", mentions_bot: false }))).toBe(false);
  });

  it("rejects channel thread replies without a mention even when thread is managed by Felix", () => {
    expect(
      shouldAcceptEvent(
        makeEvent({ visibility: "channel", mentions_bot: false }),
        { managed_by_felix: true },
      ),
    ).toBe(false);
  });

  it("rejects channel thread replies without a mention when thread is NOT managed by Felix", () => {
    expect(
      shouldAcceptEvent(
        makeEvent({ visibility: "channel", mentions_bot: false }),
        { managed_by_felix: false },
      ),
    ).toBe(false);
  });
});

describe("isOwnMessage", () => {
  it("returns true when sender id matches bot user id", () => {
    const event = makeEvent({ sender: { source: "mattermost", id: "bot-123" } });
    expect(isOwnMessage(event, "mattermost", "bot-123")).toBe(true);
  });

  it("returns true for compound source:id form", () => {
    const event = makeEvent({ sender: { source: "mattermost", id: "mattermost:bot-123" } });
    expect(isOwnMessage(event, "mattermost", "bot-123")).toBe(true);
  });

  it("returns false when sender differs from bot user id", () => {
    const event = makeEvent({ sender: { source: "mattermost", id: "other-user" } });
    expect(isOwnMessage(event, "mattermost", "bot-123")).toBe(false);
  });

  it("returns false when no bot user id is set", () => {
    const event = makeEvent({ sender: { source: "mattermost", id: "bot-123" } });
    expect(isOwnMessage(event, "mattermost", undefined)).toBe(false);
  });

  it("returns false when source does not match event source", () => {
    const event = makeEvent({ source: "slack" as never, sender: { source: "slack", id: "bot-123" } });
    expect(isOwnMessage(event, "discord", "bot-123")).toBe(false);
  });
});
