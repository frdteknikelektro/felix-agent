import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePendingPermissionThread } from "../src/slices/approvals/index.js";
import { createOrLoadThread, setPendingPermission, type ThreadHandle } from "../src/slices/sessions/index.js";
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
  await setPendingPermission(thread, request);
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

  it("falls back to a pending request without an owner-message anchor", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, "mattermost:c:a", { postId: "p1" });
    await seedPending(cfg, "mattermost:c:b", {});

    const hit = await resolvePendingPermissionThread(cfg, {
      kind: "owner_message",
      anchor: { source: "mattermost", message_id: "unknown-post" },
    });
    expect(hit?.state.thread_key).toBe("mattermost:c:b");
  });

  it("returns null when no pending thread matches", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, "mattermost:c:a", { postId: "p1" });

    const hit = await resolvePendingPermissionThread(cfg, {
      kind: "owner_message",
      anchor: { source: "mattermost", message_id: "unknown-post" },
    });
    expect(hit).toBeNull();
  });
});
