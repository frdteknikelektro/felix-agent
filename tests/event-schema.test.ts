import { describe, expect, it } from "vitest";
import { renderFrontmatter } from "../src/lib/markdown.js";
import {
  buildEventFile,
  eventAt,
  historyTitle,
  parseEventFile,
  toUniversalEvent,
} from "../src/slices/events/index.js";
import type { SessionPermissionRequest, UniversalEvent } from "../src/types.js";
import { mattermostThreadRef } from "./helpers/workspace.js";

function render(input: Parameters<typeof buildEventFile>[0]): string {
  const spec = buildEventFile(input);
  return renderFrontmatter(spec.frontmatter, spec.body);
}

const sourceEvent: UniversalEvent = {
  source: "mattermost",
  event_id: "evt-1",
  thread_key: "mattermost:c:r",
  received_at: "2026-05-25T00:00:00.000Z",
  visibility: "channel",
  mentions_bot: true,
  sender: { source: "mattermost", id: "u1", display: "Owner" },
  text: "hello felix",
  attachments: [],
  raw_path: "",
  source_thread_ref: mattermostThreadRef("c", "r", "evt-1"),
};

const request: SessionPermissionRequest = {
  request_id: "req-1",
  requested_at: "2026-05-25T01:00:00.000Z",
  skill_id: "deploy",
  permissions: ["shell"],
  reason: "ship it",
  owner_message: "may I deploy?",
  owner_message_anchor: { source: "mattermost", message_id: "p1", conversation_id: "c" },
  thread_key: "mattermost:c:r",
  requester: { source: "mattermost", id: "u1" },
  requester_event_file: "/events/req.md",
};

describe("buildEventFile / parseEventFile round-trip", () => {
  it("source_event survives the round-trip and rebuilds its UniversalEvent", () => {
    const parsed = parseEventFile(render({ kind: "source_event", event: sourceEvent }));
    expect(parsed.kind).toBe("source_event");
    const rebuilt = toUniversalEvent(parsed, "/events/evt.md");
    expect(rebuilt.event_id).toBe("evt-1");
    expect(rebuilt.text).toBe("hello felix");
    expect(rebuilt.visibility).toBe("channel");
    expect(rebuilt.mentions_bot).toBe(true);
    expect(rebuilt.source_thread_ref).toEqual(mattermostThreadRef("c", "r", "evt-1"));
  });

  it("felix_reply carries its harness session id and timestamp", () => {
    const parsed = parseEventFile(render({ kind: "felix_reply", at: "2026-05-25T02:00:00.000Z", text: "done", harnessSessionId: "session-9" }));
    expect(parsed.kind).toBe("felix_reply");
    if (parsed.kind !== "felix_reply") throw new Error("kind");
    expect(parsed.frontmatter.harness_session_id).toBe("session-9");
    expect(eventAt(parsed)).toBe("2026-05-25T02:00:00.000Z");
  });

  it("owner_permission synthesizes an owner-authored DM", () => {
    const parsed = parseEventFile(
      render({
        kind: "owner_permission",
        at: "2026-05-25T03:00:00.000Z",
        source: "mattermost",
        threadKey: "mattermost:c:r",
        decision: "approved",
        details: { owner_user_id: "owner-7", skill_id: "deploy", permissions: ["shell"], scope: "always", request_id: "req-1" },
      }),
    );
    expect(parsed.kind).toBe("owner_permission");
    const rebuilt = toUniversalEvent(parsed, "/events/perm.md");
    expect(rebuilt.visibility).toBe("dm");
    expect(rebuilt.mentions_bot).toBe(true);
    expect(rebuilt.sender.id).toBe("owner-7");
    expect(rebuilt.event_id).toBe("req-1");
    expect(eventAt(parsed)).toBe("2026-05-25T03:00:00.000Z");
  });

  it("permission_request preserves skill and anchor fields", () => {
    const parsed = parseEventFile(render({ kind: "permission_request", request }));
    expect(parsed.kind).toBe("permission_request");
    if (parsed.kind !== "permission_request") throw new Error("kind");
    expect(parsed.frontmatter.skill_id).toBe("deploy");
    expect(parsed.frontmatter.owner_message_anchor?.message_id).toBe("p1");
    expect(eventAt(parsed)).toBe("2026-05-25T01:00:00.000Z");
  });
});

describe("historyTitle", () => {
  it("titles each known kind", () => {
    const se = parseEventFile(render({ kind: "source_event", event: sourceEvent }));
    expect(historyTitle(se, "")).toBe("Source event: Owner");

    const fr = parseEventFile(render({ kind: "felix_reply", at: "t", text: "x" }));
    expect(historyTitle(fr, "")).toBe("Felix reply");

    const pr = parseEventFile(render({ kind: "permission_request", request }));
    expect(historyTitle(pr, "")).toBe("Permission request: deploy");

    const op = parseEventFile(
      render({ kind: "owner_permission", at: "t", source: "mattermost", threadKey: "k", decision: "rejected", details: { skill_id: "deploy", permissions: [], scope: "once" } }),
    );
    expect(historyTitle(op, "")).toBe("Rejected permission");
  });

  it("falls back to a truncated raw line for an unknown file", () => {
    const parsed = parseEventFile("no frontmatter here, just prose");
    expect(parsed.kind).toBe("unknown");
    expect(historyTitle(parsed, "no frontmatter here, just prose")).toBe("no frontmatter here, just prose");
    expect(eventAt(parsed)).toBeUndefined();
  });
});
