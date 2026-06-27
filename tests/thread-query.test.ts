import path from "node:path";
import { describe, expect, it } from "vitest";
import { requestApproval, resolvePendingPermissionThread, resolvePendingPermissionThreadExact } from "../src/slices/approvals/index.js";
import { createOrLoadThread, type ThreadHandle } from "../src/slices/sessions/index.js";
import type { AppConfig } from "../src/config.js";
import type { SessionPermissionRequest } from "../src/types.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

async function makeCfg(): Promise<AppConfig> {
  return makeTestConfig("felix-thread-query-");
}

async function seedPending(
  cfg: AppConfig,
  key: string,
  anchor: { postId?: string; channelId?: string },
): Promise<ThreadHandle> {
  const thread = await createOrLoadThread(cfg, {
    source: "mattermost",
    thread_key: key,
    source_thread_ref: mattermostThreadRef("c", key),
    received_at: "2026-05-25T00:00:00.000Z",
  });
  const request: SessionPermissionRequest = {
    requested_at: "2026-05-25T00:00:00.000Z",
    skill_id: "s",
    permissions: [],
    reason: "r",
    owner_message: "m",
    thread_key: key,
    requester: { source: "mattermost", id: "u" },
    requester_event_file: path.join(thread.eventsDir, "r.md"),
    owner_message_anchor: anchor.postId
      ? { source: "mattermost", message_id: anchor.postId, conversation_id: anchor.channelId }
      : undefined,
  };
  await requestApproval(cfg, thread, request);
  return thread;
}

describe("resolvePendingPermissionThread", () => {
  it("matches by thread key", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, "mattermost:c:a", { postId: "p1" });
    await seedPending(cfg, "mattermost:c:b", { postId: "p2" });

    const hit = await resolvePendingPermissionThread(cfg, { kind: "thread", threadKey: "mattermost:c:b" });
    expect(hit?.state.thread_key).toBe("mattermost:c:b");
  });

  it("matches an owner-message post over other pending threads", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, "mattermost:c:a", { postId: "p1", channelId: "c" });
    await seedPending(cfg, "mattermost:c:b", { postId: "p2", channelId: "c" });

    const hit = await resolvePendingPermissionThread(cfg, {
      kind: "owner_message",
      anchor: { source: "mattermost", message_id: "p2", conversation_id: "c" },
    });
    expect(hit?.state.thread_key).toBe("mattermost:c:b");
  });

  it("does not fall back to another pending request when the owner-message anchor is missing", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, "mattermost:c:a", { postId: "p1" });
    await seedPending(cfg, "mattermost:c:b", {});

    const hit = await resolvePendingPermissionThreadExact(cfg, {
      kind: "owner_message",
      anchor: { source: "mattermost", message_id: "unknown-post" },
    });
    expect(hit).toBeNull();
  });

  it("matches an approval id exactly", async () => {
    const cfg = await makeCfg();
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:c:approval",
      source_thread_ref: mattermostThreadRef("c", "approval"),
      received_at: "2026-05-25T00:00:00.000Z",
    });
    await requestApproval(cfg, thread, {
      request_id: "req-approval",
      requested_at: "2026-05-25T00:00:00.000Z",
      skill_id: "s",
      permissions: [],
      reason: "r",
      owner_message: "m",
      thread_key: thread.state.thread_key,
      requester: { source: "mattermost", id: "u" },
      requester_event_file: path.join(thread.eventsDir, "req-approval.md"),
    });

    const hit = await resolvePendingPermissionThreadExact(cfg, {
      kind: "approval",
      approvalId: "req-approval",
    });
    expect(hit?.state.thread_key).toBe("mattermost:c:approval");
  });

  it("returns null when no exact thread target matches", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, "mattermost:c:a", { postId: "p1" });

    const hit = await resolvePendingPermissionThreadExact(cfg, {
      kind: "thread",
      threadKey: "mattermost:c:missing",
    });
    expect(hit).toBeNull();
  });
});
