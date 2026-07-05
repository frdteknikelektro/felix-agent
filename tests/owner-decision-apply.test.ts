import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyOwnerDecision } from "../src/slices/approvals/index.js";
import { requestApproval } from "../src/slices/approvals/index.js";
import { loadContact } from "../src/slices/contacts/index.js";
import { createOrLoadThread, loadSessionState, type ThreadHandle } from "../src/slices/sessions/index.js";
import type { AppConfig } from "../src/config.js";
import type { SessionPermissionRequest } from "../src/types.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

async function makeCfg(): Promise<AppConfig> {
  return makeTestConfig("felix-owner-apply-");
}

async function seedPending(cfg: AppConfig, key = "mattermost:c:r"): Promise<ThreadHandle> {
  const thread = await createOrLoadThread(cfg, {
    source: "mattermost",
    thread_key: key,
    source_thread_ref: mattermostThreadRef("c", "r"),
    received_at: "2026-05-25T00:00:00.000Z",
  });
  const request: SessionPermissionRequest = {
    request_id: "req-1",
    requested_at: "2026-05-25T00:00:00.000Z",
    skill_id: "deploy",
    permissions: ["deploy:shell.run"],
    reason: "ship it",
    owner_message: "may I deploy?",
    thread_key: key,
    requester: { source: "mattermost", id: "u1", display: "User" },
    requester_event_file: path.join(thread.eventsDir, "2026-05-25T00-00-00Z_permission_request.md"),
  };
  await requestApproval(cfg, thread, request);
  return thread;
}

async function seedAnchoredPending(cfg: AppConfig): Promise<ThreadHandle> {
  const thread = await createOrLoadThread(cfg, {
    source: "mattermost",
    thread_key: "mattermost:c:anchored",
    source_thread_ref: mattermostThreadRef("c", "anchored"),
    received_at: "2026-05-25T00:00:00.000Z",
  });
  await requestApproval(cfg, thread, {
    request_id: "req-anchor",
    requested_at: "2026-05-25T00:00:00.000Z",
    skill_id: "deploy",
    permissions: ["deploy:shell.run"],
    reason: "ship it",
    owner_message: "may I deploy?",
    thread_key: thread.state.thread_key,
    requester: { source: "mattermost", id: "u1", display: "User" },
    requester_event_file: path.join(thread.eventsDir, "anchored_permission_request.md"),
    owner_message_anchor: { source: "mattermost", conversation_id: "owner-dm", message_id: "owner-post" },
  });
  return thread;
}

describe("applyOwnerDecision", () => {
  it("on 'always' persists the contact grant and clears pending", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg);

    const outcome = await applyOwnerDecision(cfg, {
      mode: "always",
      decidedBy: "owner",
      target: { kind: "thread", threadKey: "mattermost:c:r" },
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.grant).toMatchObject({ skillId: "deploy", permissions: ["deploy:shell.run"] });
    expect(outcome!.record?.status).toBe("approved");

    const contact = await loadContact(cfg, "mattermost", "u1");
    expect(contact.allowed_permissions).toContain("deploy:shell.run");

    const session = await loadSessionState(outcome!.thread);
    expect(session.pending_permission ?? null).toBeNull();
  });

  it("can resolve a decision by approval id", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg);

    const outcome = await applyOwnerDecision(cfg, {
      mode: "once",
      decidedBy: "owner",
      target: { kind: "approval", approvalId: "req-1" },
    });

    expect(outcome?.thread.state.thread_key).toBe("mattermost:c:r");
    expect(outcome?.record?.status).toBe("approved");
  });

  it("on 'once' grants nothing to the contact but still decides", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg);

    const outcome = await applyOwnerDecision(cfg, {
      mode: "once",
      decidedBy: "owner",
      target: { kind: "thread", threadKey: "mattermost:c:r" },
    });

    expect(outcome!.grant).toBeUndefined();
    expect(outcome!.record?.status).toBe("approved");
  });

  it("on 'reject' clears pending without a grant", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg);

    const outcome = await applyOwnerDecision(cfg, {
      mode: "reject",
      decidedBy: "owner",
      target: { kind: "thread", threadKey: "mattermost:c:r" },
    });

    expect(outcome!.grant).toBeUndefined();
    expect(outcome!.record?.status).toBe("rejected");
  });

  it("can resolve a decision by a generic owner-message anchor", async () => {
    const cfg = await makeCfg();
    await seedAnchoredPending(cfg);

    const outcome = await applyOwnerDecision(cfg, {
      mode: "once",
      decidedBy: "owner",
      target: {
        kind: "owner_message",
        anchor: { source: "mattermost", conversation_id: "owner-dm", message_id: "owner-post" },
      },
    });

    expect(outcome?.thread.state.thread_key).toBe("mattermost:c:anchored");
    expect(outcome?.record?.status).toBe("approved");
  });

  it("returns null when no pending thread matches the target", async () => {
    const cfg = await makeCfg();
    await seedPending(cfg);

    const outcome = await applyOwnerDecision(cfg, {
      mode: "always",
      decidedBy: "owner",
      target: { kind: "thread", threadKey: "mattermost:c:missing" },
    });
    expect(outcome).toBeNull();
  });
});
