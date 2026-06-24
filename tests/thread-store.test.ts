import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEventToThread, appendFelixReply, appendPermissionRequest, clearHarnessSession, createOrLoadThread, hasThreadEvent, loadSessionState, queueThreadEvent, recordTurn, requeueEvent, shiftNextEvent } from "../src/slices/sessions/index.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

async function makeThread() {
  const cfg = await makeTestConfig("felix-session-");
  return createOrLoadThread(cfg, {
    source: "mattermost",
    thread_key: "mattermost:chan:root",
    source_thread_ref: mattermostThreadRef("chan", "root"),
    received_at: "2026-05-25T00:00:00.000Z",
  });
}

const item = (id: string) => ({
  received_at: "2026-05-25T00:00:00.000Z",
  event_file: `/events/${id}.md`,
  source_event_id: id,
});

describe("thread store", () => {
  it("deduplicates queued events by source event id", async () => {
    const cfg = await makeTestConfig("felix-thread-store-");
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:chan:root",
      source_thread_ref: mattermostThreadRef("chan", "root"),
      received_at: "2026-05-25T00:00:00.000Z",
    });

    await queueThreadEvent(thread, {
      received_at: "2026-05-25T00:00:00.000Z",
      event_file: path.join(thread.eventsDir, "2026-05-25T00-00-00Z_mattermost_evt.md"),
      source_event_id: "evt",
    });
    await queueThreadEvent(thread, {
      received_at: "2026-05-25T00:00:01.000Z",
      event_file: path.join(thread.eventsDir, "2026-05-25T00-00-01Z_mattermost_evt.md"),
      source_event_id: "evt",
    });

    const session = await loadSessionState(thread);
    expect(session.queue).toHaveLength(1);
    expect(session.queue[0]?.source_event_id).toBe("evt");
  });

  it("detects already recorded thread events by source and event id", async () => {
    const cfg = await makeTestConfig("felix-thread-event-");
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:chan:root",
      source_thread_ref: mattermostThreadRef("chan", "root"),
      received_at: "2026-05-25T00:00:00.000Z",
    });
    await appendEventToThread(thread, {
      source: "mattermost",
      event_id: "evt",
      thread_key: "mattermost:chan:root",
      received_at: "2026-05-25T00:00:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "user" },
      text: "hello",
      attachments: [],
      raw_path: "",
      source_thread_ref: mattermostThreadRef("chan", "root", "evt"),
    });

    await expect(hasThreadEvent(thread, "mattermost", "evt")).resolves.toBe(true);
    await expect(hasThreadEvent(thread, "mattermost", "other")).resolves.toBe(false);
  });

  it("stores non-Mattermost sessions without channel or root-post assumptions", async () => {
    const cfg = await makeTestConfig("felix-slack-session-");
    const thread = await createOrLoadThread(cfg, {
      source: "slack",
      thread_key: "slack:C123:1717000000.000100",
      source_thread_ref: {
        source: "slack",
        conversation_id: "C123",
        thread_id: "1717000000.000100",
        root_message_id: "1717000000.000100",
      },
      received_at: "2026-05-25T00:00:00.000Z",
    });

    expect(thread.dir).toContain(path.join("sessions", "slack"));
    await expect(fs.stat(path.join(cfg.paths.threadKeyIndex, "slack", "slack_C123_1717000000.000100.json"))).resolves.toBeTruthy();
    expect(thread.state.source_thread_ref).toMatchObject({ source: "slack", conversation_id: "C123" });
  });
});

describe("session transitions", () => {
  it("shiftNextEvent pops FIFO and returns null on an empty queue", async () => {
    const thread = await makeThread();
    await queueThreadEvent(thread, item("a"));
    await queueThreadEvent(thread, item("b"));

    const first = await shiftNextEvent(thread);
    expect(first?.item.source_event_id).toBe("a");
    expect(first?.session.queue.map((q) => q.source_event_id)).toEqual(["b"]);

    const second = await shiftNextEvent(thread);
    expect(second?.item.source_event_id).toBe("b");

    expect(await shiftNextEvent(thread)).toBeNull();
  });

  it("requeueEvent puts the event back at the head and can drop the harness session", async () => {
    const thread = await makeThread();
    await queueThreadEvent(thread, item("b"));
    await recordTurn(thread, "session-123");

    await requeueEvent(thread, item("a"), { clearHarnessSession: true });

    const session = await loadSessionState(thread);
    expect(session.queue.map((q) => q.source_event_id)).toEqual(["a", "b"]);
    expect(session.harness_session_id).toBeUndefined();
  });

  it("recordTurn stamps the harness session and turn time in one write", async () => {
    const thread = await makeThread();
    const session = await recordTurn(thread, "session-xyz");
    expect(session.harness_session_id).toBe("session-xyz");
    expect(session.last_turn_at).toBeTruthy();

    const reloaded = await loadSessionState(thread);
    expect(reloaded.harness_session_id).toBe("session-xyz");
    expect(reloaded.last_turn_at).toBe(session.last_turn_at);
  });

  it("clearHarnessSession forgets the harness session", async () => {
    const thread = await makeThread();
    await recordTurn(thread, "session-xyz");
    await clearHarnessSession(thread);
    expect((await loadSessionState(thread)).harness_session_id).toBeUndefined();
  });
});

describe("thread event writer", () => {
  it("writes the event file and a transcript block that points back at it", async () => {
    const thread = await makeThread();
    const file = await appendFelixReply(thread, "2026-05-25T00:00:00.000Z", "hello owner", "session-1");

    await expect(fs.stat(file)).resolves.toBeTruthy();
    const body = await fs.readFile(file, "utf8");
    expect(body).toContain("type: felix_reply");
    expect(body).toContain("hello owner");

    const transcript = await fs.readFile(thread.transcriptFile, "utf8");
    expect(transcript).toContain("hello owner");
    expect(transcript).toContain(`Event file: ${path.relative(thread.dir, file)}`);
  });

  it("writes a permission_request to its pre-computed path with a transcript pointer", async () => {
    const thread = await makeThread();
    const requesterFile = path.join(thread.eventsDir, "2026-05-25T00-00-00Z_permission_request.md");
    const file = await appendPermissionRequest(thread, {
      request_id: "req-1",
      requested_at: "2026-05-25T00:00:00.000Z",
      skill_id: "deploy",
      permissions: ["shell"],
      reason: "ship",
      owner_message: "ok?",
      thread_key: thread.state.thread_key,
      requester: { source: "mattermost", id: "u1" },
      requester_event_file: requesterFile,
    });

    expect(file).toBe(requesterFile);
    const body = await fs.readFile(file, "utf8");
    expect(body).toContain("type: permission_request");
    expect(body).toContain("deploy");

    const transcript = await fs.readFile(thread.transcriptFile, "utf8");
    expect(transcript).toContain(`Event file: ${path.relative(thread.dir, file)}`);
  });
});
