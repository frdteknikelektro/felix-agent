import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { handleSourceEventIntake, handleSourceReactionIntake } from "../src/core/source-intake.js";
import { createOrLoadThread, appendEventToThread, setPendingPermission } from "../src/slices/sessions/index.js";
import type { SessionPermissionRequest, UniversalEvent } from "../src/types.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

async function makeCfg(): Promise<AppConfig> {
  return makeTestConfig("felix-source-intake-");
}

function makeEvent(overrides: Partial<UniversalEvent> = {}): UniversalEvent {
  return {
    source: "mattermost",
    event_id: "evt-1",
    thread_key: "mattermost:c:root",
    received_at: "2026-05-25T00:01:00.000Z",
    visibility: "channel",
    mentions_bot: true,
    sender: { source: "mattermost", id: "user" },
    text: "hello",
    attachments: [],
    raw_path: "",
    source_thread_ref: mattermostThreadRef("c", "root", "evt-1"),
    ...overrides,
  };
}

async function seedPending(
  cfg: AppConfig,
  anchor: { conversationId: string; messageId: string },
): Promise<void> {
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
      source: "mattermost",
      conversation_id: anchor.conversationId,
      message_id: anchor.messageId,
    },
  };
  await setPendingPermission(thread, request);
}

describe("Source intake", () => {
  it("persists source evidence before normal engine ingest", async () => {
    const cfg = await makeCfg();
    const event = makeEvent();
    const ingest = vi.fn().mockResolvedValue(undefined);
    const handleOwnerDecision = vi.fn().mockResolvedValue(true);

    await expect(handleSourceEventIntake(cfg, {
      event,
      ports: { ingest, handleOwnerDecision },
    })).resolves.toEqual({ kind: "ingested" });

    expect(ingest).toHaveBeenCalledWith(event);
    expect(handleOwnerDecision).not.toHaveBeenCalled();
    expect(event.raw_path).toContain(path.join("intake", "mattermost", "raw"));
    await expect(fs.stat(event.raw_path)).resolves.toBeTruthy();
  });

  it("suppresses durable duplicate source events before ingest", async () => {
    const cfg = await makeCfg();
    const existing = makeEvent();
    const thread = await createOrLoadThread(cfg, existing);
    await appendEventToThread(thread, existing);
    const duplicate = makeEvent();
    const ingest = vi.fn().mockResolvedValue(undefined);

    await expect(handleSourceEventIntake(cfg, {
      event: duplicate,
      ports: { ingest, handleOwnerDecision: vi.fn() },
    })).resolves.toEqual({ kind: "duplicate" });

    expect(ingest).not.toHaveBeenCalled();
    expect(duplicate.raw_path).toBe("");
  });

  it("routes owner text decisions before normal ingest", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { conversationId: "owner-dm", messageId: "owner-post" });
    const ownerEvent = makeEvent({
      event_id: "reply-1",
      thread_key: "mattermost:owner-dm:owner-post",
      visibility: "dm",
      mentions_bot: false,
      sender: { source: "mattermost", id: "owner" },
      text: "yes",
      source_thread_ref: mattermostThreadRef("owner-dm", "owner-post", "reply-1"),
    });
    const ingest = vi.fn().mockResolvedValue(undefined);
    const handleOwnerDecision = vi.fn().mockResolvedValue(true);

    const result = await handleSourceEventIntake(cfg, {
      event: ownerEvent,
      owner: { decidedBy: "owner" },
      ports: { ingest, handleOwnerDecision },
    });

    expect(result).toEqual({ kind: "owner_decision", handled: true });
    expect(ingest).not.toHaveBeenCalled();
    expect(handleOwnerDecision).toHaveBeenCalledWith(expect.objectContaining({ mode: "once" }));
    await expect(fs.stat(ownerEvent.raw_path)).resolves.toBeTruthy();
  });

  it("ingests owner text that is not a decision", async () => {
    const cfg = await makeCfg();
    const ownerEvent = makeEvent({
      sender: { source: "mattermost", id: "owner" },
      text: "hello",
    });
    const ingest = vi.fn().mockResolvedValue(undefined);

    await expect(handleSourceEventIntake(cfg, {
      event: ownerEvent,
      owner: { decidedBy: "owner" },
      ports: { ingest, handleOwnerDecision: vi.fn() },
    })).resolves.toEqual({ kind: "owner_non_decision", route: "not_decision", ingested: true });

    expect(ingest).toHaveBeenCalledWith(ownerEvent);
  });

  it("falls back to ingest when an owner text decision no longer matches pending approval", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { conversationId: "owner-dm", messageId: "owner-post" });
    const ownerEvent = makeEvent({
      event_id: "reply-stale",
      thread_key: "mattermost:owner-dm:missing-post",
      visibility: "dm",
      mentions_bot: false,
      sender: { source: "mattermost", id: "owner" },
      text: "yes",
      source_thread_ref: mattermostThreadRef("owner-dm", "missing-post", "reply-stale"),
    });
    const ingest = vi.fn().mockResolvedValue(undefined);
    const handleOwnerDecision = vi.fn().mockResolvedValue(true);

    await expect(handleSourceEventIntake(cfg, {
      event: ownerEvent,
      owner: { decidedBy: "owner" },
      ports: { ingest, handleOwnerDecision },
    })).resolves.toEqual({ kind: "owner_non_decision", route: "no_pending_approval", ingested: true });

    expect(ingest).toHaveBeenCalledWith(ownerEvent);
    expect(handleOwnerDecision).not.toHaveBeenCalled();
  });

  it("falls back to ingest when the owner decision port declines a text decision", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { conversationId: "owner-dm", messageId: "owner-post" });
    const ownerEvent = makeEvent({
      event_id: "reply-declined",
      thread_key: "mattermost:owner-dm:owner-post",
      visibility: "dm",
      mentions_bot: false,
      sender: { source: "mattermost", id: "owner" },
      text: "yes",
      source_thread_ref: mattermostThreadRef("owner-dm", "owner-post", "reply-declined"),
    });
    const ingest = vi.fn().mockResolvedValue(undefined);
    const handleOwnerDecision = vi.fn().mockResolvedValue(false);

    await expect(handleSourceEventIntake(cfg, {
      event: ownerEvent,
      owner: { decidedBy: "owner" },
      ports: { ingest, handleOwnerDecision },
    })).resolves.toEqual({ kind: "owner_decision", handled: false, ingested: true });

    expect(handleOwnerDecision).toHaveBeenCalledWith(expect.objectContaining({ mode: "once" }));
    expect(ingest).toHaveBeenCalledWith(ownerEvent);
  });

  it("routes owner reactions without ingesting", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { conversationId: "owner-dm", messageId: "owner-post" });
    const ingest = vi.fn().mockResolvedValue(undefined);
    const handleOwnerDecision = vi.fn().mockResolvedValue(true);

    const result = await handleSourceReactionIntake(cfg, {
      source: "mattermost",
      token: "thumbsup",
      decidedBy: "owner",
      anchor: {
        source: "mattermost",
        conversation_id: "owner-dm",
        message_id: "owner-post",
        thread_id: "owner-post",
      },
      ports: { ingest, handleOwnerDecision },
    });

    expect(result).toEqual({ kind: "owner_decision", handled: true });
    expect(ingest).not.toHaveBeenCalled();
    expect(handleOwnerDecision).toHaveBeenCalledWith(expect.objectContaining({ mode: "always" }));
  });

  it("does not ingest stale owner reactions", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg, { conversationId: "owner-dm", messageId: "owner-post" });
    const ingest = vi.fn().mockResolvedValue(undefined);
    const handleOwnerDecision = vi.fn().mockResolvedValue(true);

    await expect(handleSourceReactionIntake(cfg, {
      source: "mattermost",
      token: "thumbsup",
      decidedBy: "owner",
      anchor: {
        source: "mattermost",
        conversation_id: "owner-dm",
        message_id: "missing-post",
        thread_id: "missing-post",
      },
      ports: { ingest, handleOwnerDecision },
    })).resolves.toEqual({ kind: "no_pending_approval" });

    expect(ingest).not.toHaveBeenCalled();
    expect(handleOwnerDecision).not.toHaveBeenCalled();
  });
});
