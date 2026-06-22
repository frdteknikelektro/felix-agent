import { describe, expect, it } from "vitest";
import { buildDashboardSnapshot, chatMessageFromEvent, type SessionSummary } from "../src/owner-data.js";
import type { ParsedEvent } from "../src/slices/events/index.js";
import type { ApprovalRecord } from "../src/slices/approvals/index.js";
import type { AuditEntry } from "../src/slices/audit/index.js";

describe("chatMessageFromEvent", () => {
  it("maps a source event to an inbound bubble with full text and sender", () => {
    const parsed: ParsedEvent = {
      kind: "source_event",
      frontmatter: {
        type: "source_event",
        event_id: "evt-1",
        received_at: "2026-06-01T10:00:00.000Z",
        sender: { source: "mattermost", id: "u1", display: "@alice" },
      },
      body: "  hello felix  ",
    };
    const msg = chatMessageFromEvent(parsed, "2026-06-01T10:00:00.000Z", "file.md", "mattermost");
    expect(msg).toEqual({
      id: "evt-1",
      at: "2026-06-01T10:00:00.000Z",
      kind: "source_event",
      direction: "inbound",
      sender: { source: "mattermost", id: "u1", display: "@alice" },
      text: "hello felix",
    });
  });

  it("maps a felix reply to an outbound bubble from Felix", () => {
    const parsed: ParsedEvent = {
      kind: "felix_reply",
      frontmatter: { type: "felix_reply", at: "2026-06-01T10:01:00.000Z" },
      body: "sure thing",
    };
    const msg = chatMessageFromEvent(parsed, "2026-06-01T10:01:00.000Z", "file.md", "discord");
    expect(msg.direction).toBe("outbound");
    expect(msg.sender).toEqual({ source: "discord", id: "felix", display: "Felix" });
    expect(msg.text).toBe("sure thing");
  });

  it("maps permission events to system bubbles", () => {
    const request: ParsedEvent = {
      kind: "permission_request",
      frontmatter: { type: "permission_request", request_id: "req-9", skill_id: "deploy" },
      body: "Permission required for deploy.",
    };
    const decision: ParsedEvent = {
      kind: "owner_permission",
      frontmatter: { type: "owner_permission", request_id: "req-9", decision: "approved", owner_user_id: "owner-1" },
      body: "Approved permission for deploy.",
    };
    expect(chatMessageFromEvent(request, "2026-06-01T10:02:00.000Z", "f.md", "slack").direction).toBe("system");
    const ownerMsg = chatMessageFromEvent(decision, "2026-06-01T10:03:00.000Z", "f.md", "slack");
    expect(ownerMsg.direction).toBe("system");
    expect(ownerMsg.sender).toEqual({ source: "owner", id: "owner-1", display: "Owner" });
  });

  it("falls back to the file name when an event id is missing", () => {
    const parsed: ParsedEvent = {
      kind: "source_event",
      frontmatter: { type: "source_event", sender: { source: "mattermost", id: "u1" } },
      body: "hi",
    };
    expect(chatMessageFromEvent(parsed, "2026-06-01T10:00:00.000Z", "fallback.md", "mattermost").id).toBe("fallback.md");
  });
});

describe("buildDashboardSnapshot", () => {
  const now = new Date("2026-06-22T12:00:00.000Z");

  function summary(over: Partial<SessionSummary>): SessionSummary {
    return {
      threadKey: "mattermost:c1:r1",
      source: "mattermost",
      harness: "Codex",
      createdAt: "2026-06-22T08:00:00.000Z",
      updatedAt: "2026-06-22T11:00:00.000Z",
      managedByFelix: true,
      busy: false,
      queueLength: 0,
      ...over,
    };
  }

  function approval(over: Partial<ApprovalRecord>): ApprovalRecord {
    return {
      id: "a1",
      requestId: "a1",
      threadKey: "mattermost:c1:r1",
      source: "mattermost",
      status: "pending",
      requestedAt: "2026-06-22T10:00:00.000Z",
      skillId: "deploy",
      permissions: ["shell"],
      reason: "needs deploy",
      ownerMessage: "approve?",
      requester: { source: "mattermost", id: "u1" },
      requestPath: "/x/a1.json",
      ...over,
    };
  }

  it("computes counters from session and approval state", () => {
    const snap = buildDashboardSnapshot(
      [
        summary({ threadKey: "t1", busy: true, queueLength: 2 }),
        summary({ threadKey: "t2", busy: false, queueLength: 1 }),
        summary({ threadKey: "t3", busy: true, queueLength: 0, createdAt: "2026-06-20T08:00:00.000Z" }),
      ],
      [approval({ id: "a1", status: "pending" }), approval({ id: "a2", status: "approved" })],
      [],
      now,
    );
    expect(snap.activeSessions).toBe(2);
    expect(snap.totalQueueDepth).toBe(3);
    expect(snap.pendingApprovals).toBe(1);
    expect(snap.sessionsToday).toBe(2); // t1, t2 created today; t3 created 2026-06-20
    expect(snap.pendingApprovalList).toHaveLength(1);
    expect(snap.pendingApprovalList[0]!.id).toBe("a1");
    expect(snap.at).toBe("2026-06-22T12:00:00.000Z");
  });

  it("orders busy sessions first in the active list", () => {
    const snap = buildDashboardSnapshot(
      [
        summary({ threadKey: "idle", busy: false, updatedAt: "2026-06-22T11:30:00.000Z" }),
        summary({ threadKey: "busy", busy: true, updatedAt: "2026-06-22T10:00:00.000Z" }),
      ],
      [],
      [],
      now,
    );
    expect(snap.activeSessionList[0]!.threadKey).toBe("busy");
  });

  it("merges audit entries and session turn/message activity, newest first", () => {
    const audit: AuditEntry[] = [
      {
        id: "au1",
        at: "2026-06-22T11:45:00.000Z",
        actor: "owner",
        source: "ui",
        action: "approve",
        entity_type: "approval",
        entity_id: "a1",
        summary: "Approved deploy",
      },
    ];
    const snap = buildDashboardSnapshot(
      [summary({ threadKey: "t1", lastTurnAt: "2026-06-22T11:50:00.000Z", lastEventAt: "2026-06-22T11:40:00.000Z" })],
      [],
      audit,
      now,
    );
    const kinds = snap.recentActivity.map((a) => a.kind);
    expect(kinds).toContain("audit");
    expect(kinds).toContain("turn");
    expect(kinds).toContain("message");
    // Newest first: the 11:50 turn precedes the 11:45 audit entry.
    expect(snap.recentActivity[0]!.kind).toBe("turn");
    expect(snap.recentActivity[0]!.at).toBe("2026-06-22T11:50:00.000Z");
  });

  it("does not emit a duplicate message item when lastEventAt equals lastTurnAt", () => {
    const snap = buildDashboardSnapshot(
      [summary({ threadKey: "t1", lastTurnAt: "2026-06-22T11:50:00.000Z", lastEventAt: "2026-06-22T11:50:00.000Z" })],
      [],
      [],
      now,
    );
    expect(snap.recentActivity.filter((a) => a.kind === "message")).toHaveLength(0);
    expect(snap.recentActivity.filter((a) => a.kind === "turn")).toHaveLength(1);
  });
});
