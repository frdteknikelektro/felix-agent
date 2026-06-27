import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideApproval,
  findPendingApproval,
  listApprovalRecords,
  listPendingApprovals,
  requestApproval,
} from "../src/slices/approvals/index.js";
import { loadContact } from "../src/slices/contacts/index.js";
import { createOrLoadThread, loadSessionState, setPendingPermission } from "../src/slices/sessions/index.js";
import type { AppConfig } from "../src/config.js";
import type { SessionPermissionRequest } from "../src/types.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

async function makeCfg(prefix: string): Promise<AppConfig> {
  return makeTestConfig(prefix);
}

async function seedPending(cfg: AppConfig) {
  const thread = await createOrLoadThread(cfg, {
    source: "mattermost",
    thread_key: "mattermost:chan:root",
    source_thread_ref: mattermostThreadRef("chan", "root"),
    received_at: "2026-05-25T00:00:00.000Z",
  });
  const request: SessionPermissionRequest = {
    request_id: "req-1",
    requested_at: "2026-05-25T00:00:00.000Z",
    skill_id: "test-skill",
    permissions: ["net:fetch"],
    reason: "needs network",
    owner_message: "Owner approval required.",
    thread_key: thread.state.thread_key,
    requester: { source: "mattermost", id: "user-7", display: "Jala" },
    requester_event_file: path.join(thread.eventsDir, "req_permission_request.md"),
  };
  await requestApproval(cfg, thread, request);
  return { thread, request };
}

describe("approval lifecycle", () => {
  it("requestApproval marks the thread pending and stores a pending record", async () => {
    const cfg = await makeCfg("felix-approval-req-");
    const { thread } = await seedPending(cfg);

    const session = await loadSessionState(thread);
    expect(session.pending_permission?.request_id).toBe("req-1");

    const records = await listApprovalRecords(cfg);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("pending");
    expect(records[0]?.skillId).toBe("test-skill");
  });

  it("lists pending approvals from registry records", async () => {
    const cfg = await makeCfg("felix-approval-pending-list-");
    const { thread } = await seedPending(cfg);

    const pending = await listPendingApprovals(cfg);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.thread.state.thread_key).toBe(thread.state.thread_key);
    expect(pending[0]?.record.status).toBe("pending");
    expect(pending[0]?.request).toMatchObject({
      request_id: "req-1",
      skill_id: "test-skill",
      requester_event_file: path.join(thread.eventsDir, "req_permission_request.md"),
    });
  });

  it("does not treat a session-only pending permission as a pending approval", async () => {
    const cfg = await makeCfg("felix-approval-session-only-");
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:chan:session-only",
      source_thread_ref: mattermostThreadRef("chan", "session-only"),
      received_at: "2026-05-25T00:00:00.000Z",
    });
    await setPendingPermission(thread, {
      request_id: "session-only",
      requested_at: "2026-05-25T00:00:00.000Z",
      skill_id: "test-skill",
      permissions: ["net:fetch"],
      reason: "needs network",
      owner_message: "Owner approval required.",
      thread_key: thread.state.thread_key,
      requester: { source: "mattermost", id: "user-7", display: "Jala" },
      requester_event_file: path.join(thread.eventsDir, "session_only_permission_request.md"),
    });

    await expect(findPendingApproval(cfg, { kind: "thread", threadKey: thread.state.thread_key })).resolves.toBeNull();
  });

  it("reject decision clears pending, marks rejected, grants nothing", async () => {
    const cfg = await makeCfg("felix-approval-reject-");
    const { thread, request } = await seedPending(cfg);

    const result = await decideApproval(cfg, thread, request, { mode: "reject" }, "owner-1", "2026-05-25T01:00:00.000Z");

    expect(result.grant).toBeUndefined();
    expect(result.record?.status).toBe("rejected");
    expect((await loadSessionState(thread)).pending_permission).toBeNull();
    await expect(fs.stat(result.decisionFile)).resolves.toBeTruthy();
  });

  it("once approval approves without persisting a contact grant", async () => {
    const cfg = await makeCfg("felix-approval-once-");
    const { thread, request } = await seedPending(cfg);

    const result = await decideApproval(cfg, thread, request, { mode: "once" }, "owner-1", "2026-05-25T01:00:00.000Z");

    expect(result.record?.status).toBe("approved");
    expect(result.grant).toBeUndefined();
    expect((await loadSessionState(thread)).pending_permission).toBeNull();
  });

  it("always approval returns a grant intent without persisting a contact", async () => {
    const cfg = await makeCfg("felix-approval-always-");
    const { thread, request } = await seedPending(cfg);

    const result = await decideApproval(cfg, thread, request, { mode: "always" }, "owner-1", "2026-05-25T01:00:00.000Z");

    expect(result.record?.status).toBe("approved");
    expect(result.grant).toBeDefined();
    expect(result.grant?.skillId).toBe("test-skill");
    expect(result.grant?.permissions).toContain("net:fetch");
    expect(result.grant?.requester.id).toBe("user-7");
    // decideApproval names the grant but leaves the merge + persistence to the caller.
    const stored = await loadContact(cfg, "mattermost", "user-7");
    expect(stored.allowed_permissions).not.toContain("net:fetch");
  });
});
