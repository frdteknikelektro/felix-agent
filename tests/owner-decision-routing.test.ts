import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  isOwnerDecisionReactionToken,
  requestApproval,
  routeOwnerDecisionFromEvent,
  routeOwnerDecisionFromReaction,
} from "../src/slices/approvals/index.js";
import { createOrLoadThread, type ThreadHandle } from "../src/slices/sessions/index.js";
import type { SessionPermissionRequest, UniversalEvent } from "../src/types.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

async function makeCfg(): Promise<AppConfig> {
  return makeTestConfig("felix-owner-routing-");
}

async function seedPending(
  cfg: AppConfig,
  anchor: { source?: string; conversationId: string; messageId: string },
): Promise<ThreadHandle> {
  const thread = await createOrLoadThread(cfg, {
    source: "mattermost",
    thread_key: "mattermost:c:root",
    source_thread_ref: mattermostThreadRef("c", "root"),
    received_at: "2026-05-25T00:00:00.000Z",
  });
  const request: SessionPermissionRequest = {
    request_id: "req-1",
    requested_at: "2026-05-25T00:00:00.000Z",
    skill_id: "deploy",
    permissions: ["shell.run"],
    reason: "ship it",
    owner_message: "may I deploy?",
    thread_key: thread.state.thread_key,
    requester: { source: "mattermost", id: "user" },
    requester_event_file: path.join(thread.eventsDir, "permission_request.md"),
    owner_message_anchor: {
      source: anchor.source ?? "mattermost",
      conversation_id: anchor.conversationId,
      message_id: anchor.messageId,
    },
  };
  await requestApproval(cfg, thread, request);
  return thread;
}

function ownerReplyEvent(text: string, rootMessageId: string): UniversalEvent {
  return {
    source: "mattermost",
    event_id: "reply-1",
    thread_key: `mattermost:owner-dm:${rootMessageId}`,
    received_at: "2026-05-25T00:01:00.000Z",
    visibility: "dm",
    mentions_bot: false,
    sender: { source: "mattermost", id: "owner" },
    text,
    attachments: [],
    raw_path: "",
    source_thread_ref: mattermostThreadRef("owner-dm", rootMessageId, "reply-1"),
  };
}

describe("Owner decision routing", () => {
  it("routes text owner decisions from a UniversalEvent", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { conversationId: "owner-dm", messageId: "owner-post" });

    const routed = await routeOwnerDecisionFromEvent(cfg, {
      event: ownerReplyEvent("yes", "owner-post"),
      decidedBy: "owner",
    });

    expect(routed.kind).toBe("routed");
    if (routed.kind === "routed") {
      expect(routed.decision).toEqual({
        mode: "once",
        decidedBy: "owner",
        target: {
          kind: "owner_message",
          anchor: {
            source: "mattermost",
            conversation_id: "owner-dm",
            message_id: "owner-post",
            thread_id: "owner-post",
          },
        },
      });
    }
  });

  it("routes reaction tokens from an explicit owner-message anchor", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { source: "slack", conversationId: "D1", messageId: "123.456" });

    const routed = await routeOwnerDecisionFromReaction(cfg, {
      source: "slack",
      token: "thumbsup",
      decidedBy: "owner-slack",
      anchor: { source: "slack", conversation_id: "D1", message_id: "123.456", thread_id: "123.456" },
    });

    expect(routed.kind).toBe("routed");
    if (routed.kind === "routed") {
      expect(routed.decision.mode).toBe("always");
      expect(routed.decision.decidedBy).toBe("owner-slack");
    }
  });

  it("distinguishes non-decisions from decisions with no pending approval", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { conversationId: "owner-dm", messageId: "owner-post" });

    await expect(routeOwnerDecisionFromEvent(cfg, {
      event: ownerReplyEvent("hello", "owner-post"),
      decidedBy: "owner",
    })).resolves.toEqual({ kind: "not_decision" });

    await expect(routeOwnerDecisionFromEvent(cfg, {
      event: ownerReplyEvent("yes", "missing-post"),
      decidedBy: "owner",
    })).resolves.toEqual({ kind: "no_pending_approval" });
  });

  it("returns no_pending_approval for decision reactions on stale anchors", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { source: "discord", conversationId: "dm", messageId: "owner-post" });

    await expect(routeOwnerDecisionFromReaction(cfg, {
      source: "discord",
      token: "👌",
      decidedBy: "owner-discord",
      anchor: { source: "discord", conversation_id: "dm", message_id: "other-post", thread_id: "other-post" },
    })).resolves.toEqual({ kind: "no_pending_approval" });
  });

  it("recognizes decision reaction tokens without resolving pending approvals", () => {
    expect(isOwnerDecisionReactionToken("thumbsup")).toBe(true);
    expect(isOwnerDecisionReactionToken("heart")).toBe(false);
  });
});
