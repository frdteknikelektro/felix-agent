import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FelixEngine } from "../src/engine.js";
import { appendEventToThread, createOrLoadThread, hasThreadEvent, queueThreadEvent } from "../src/slices/sessions/index.js";
import type { SourceAdapter, TurnInput, TurnResult } from "../src/core/ports.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

function makeAdapter(calls: {
  sendThreadReply: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  updateEventStatus: ReturnType<typeof vi.fn>;
  downloadAttachment: ReturnType<typeof vi.fn>;
}): SourceAdapter {
  return {
    source: "mattermost",
    botUserId: undefined,
    ownerUserId: undefined,
    getThreadLink: async () => undefined,
    getTurnContext: async () => ({ behaviorInstructions: [], owner: { display: "Owner" } }),
    updateEventStatus: async (input) => { calls.updateEventStatus(input); },
    sendTyping: async () => {},
    sendThreadReply: async (input) => { calls.sendThreadReply(input); },
    sendUserMessage: async (input) => { calls.sendUserMessage(input); return null; },
    downloadAttachment: async (input) => { calls.downloadAttachment(input); return input.attachment; },
  };
}

function makeRecordHarness(inputs: TurnInput[]): { run: (input: TurnInput) => Promise<TurnResult> } {
  return {
    async run(input: TurnInput): Promise<TurnResult> {
      inputs.push(input);
      return { sessionId: `s${inputs.length}`, exitCode: 0, success: true, parsed: { kind: "reply", text: "ok" }, logPath: "/dev/null" };
    },
  };
}

describe("FelixEngine Mattermost routing", () => {
  it("accepts unmentioned replies in threads already managed by Felix", async () => {
    const cfg = await makeTestConfig("felix-engine-routing-");

    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const adapter = makeAdapter(calls);

    const engine = new FelixEngine(cfg, [adapter], new FakeHarness());
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:channel:root",
      source_thread_ref: mattermostThreadRef("channel", "root"),
      received_at: "2026-05-25T00:00:00.000Z",
    });

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-2",
      thread_key: "mattermost:channel:root",
      received_at: "2026-05-25T00:01:00.000Z",
      visibility: "channel",
      mentions_bot: false,
      sender: { source: "mattermost", id: "someone-else" },
      text: "replying in the same long thread",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "ignored", "evt-2.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-2"),
    });

    // Unmentioned reply in a managed thread is accepted (queued without processing status)
    expect(calls.updateEventStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing" }),
    );
    expect(await hasThreadEvent(thread, "mattermost", "evt-2")).toBe(true);
  });

  it("merges preceding non-mention events with the first mention trigger in queue", async () => {
    const cfg = await makeTestConfig("felix-queue-merge-");
    const harnessInputs: TurnInput[] = [];
    const harness = makeRecordHarness(harnessInputs);

    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], harness);

    // Seed a managed thread
    const threadKey = "mattermost:channel:merge";
    await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: threadKey,
      source_thread_ref: mattermostThreadRef("channel", "merge-root"),
      received_at: "2026-05-25T00:00:00.000Z",
    });

    const ref = mattermostThreadRef("channel", "merge-root");

    // ev1: no mention → queued, no processing
    await engine.ingest({
      source: "mattermost", event_id: "ev1", thread_key: threadKey,
      received_at: "2026-05-25T00:01:00.000Z", visibility: "channel",
      mentions_bot: false, sender: { source: "mattermost", id: "user-a" },
      text: "msg1", attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "ev1.json"),
      source_thread_ref: { ...ref, message_id: "ev1" },
    });

    // ev2: no mention → queued, no processing
    await engine.ingest({
      source: "mattermost", event_id: "ev2", thread_key: threadKey,
      received_at: "2026-05-25T00:02:00.000Z", visibility: "channel",
      mentions_bot: false, sender: { source: "mattermost", id: "user-b" },
      text: "msg2", attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "ev2.json"),
      source_thread_ref: { ...ref, message_id: "ev2" },
    });

    // ev3: @mention → triggers first processing turn
    await engine.ingest({
      source: "mattermost", event_id: "ev3", thread_key: threadKey,
      received_at: "2026-05-25T00:03:00.000Z", visibility: "channel",
      mentions_bot: true, sender: { source: "mattermost", id: "user-c" },
      text: "msg3 @felix", attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "ev3.json"),
      source_thread_ref: { ...ref, message_id: "ev3" },
    });

    // Wait for the first turn to finish before queueing more events
    await engine.drain();

    expect(harnessInputs).toHaveLength(1);
    expect(harnessInputs[0].event.event_id).toBe("ev3");
    expect(harnessInputs[0].precedingEvents?.map(e => e.event.event_id)).toEqual(["ev1", "ev2"]);

    // ev4: no mention → queued, no processing
    await engine.ingest({
      source: "mattermost", event_id: "ev4", thread_key: threadKey,
      received_at: "2026-05-25T00:04:00.000Z", visibility: "channel",
      mentions_bot: false, sender: { source: "mattermost", id: "user-d" },
      text: "msg4", attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "ev4.json"),
      source_thread_ref: { ...ref, message_id: "ev4" },
    });

    // ev5: @mention → triggers second processing turn
    await engine.ingest({
      source: "mattermost", event_id: "ev5", thread_key: threadKey,
      received_at: "2026-05-25T00:05:00.000Z", visibility: "channel",
      mentions_bot: true, sender: { source: "mattermost", id: "user-e" },
      text: "msg5 @felix", attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "ev5.json"),
      source_thread_ref: { ...ref, message_id: "ev5" },
    });

    await engine.drain();

    expect(harnessInputs).toHaveLength(2);
    // Second turn: trigger=ev5, preceding=[ev4]
    expect(harnessInputs[1].event.event_id).toBe("ev5");
    expect(harnessInputs[1].precedingEvents?.map(e => e.event.event_id)).toEqual(["ev4"]);
  });

  it("treats system sender events as triggers (proceed-event after approval)", async () => {
    const cfg = await makeTestConfig("felix-system-trigger-");
    const harnessInputs: TurnInput[] = [];
    const harness = makeRecordHarness(harnessInputs);

    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], harness);

    const ref = mattermostThreadRef("channel", "sys-root");
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:channel:sys",
      source_thread_ref: ref,
      received_at: "2026-05-25T00:00:00.000Z",
    });

    // Simulate a queued proceed event (sender.id === "system")
    const proceedEvent = {
      source: "mattermost",
      thread_key: "mattermost:channel:sys",
      event_id: `proceed-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      received_at: new Date().toISOString(),
      visibility: "channel" as const,
      mentions_bot: false,
      sender: { source: "mattermost" as const, id: "system" },
      text: "Permission granted. Proceed with the pending request.",
      attachments: [],
      raw_path: "",
      source_thread_ref: ref,
    };
    const eventFile = await appendEventToThread(thread, proceedEvent);
    await queueThreadEvent(thread, {
      received_at: proceedEvent.received_at,
      event_file: eventFile,
      source_event_id: proceedEvent.event_id,
    });

    await engine.processThread(thread);
    await engine.drain();

    expect(harnessInputs).toHaveLength(1);
    expect(harnessInputs[0].event.event_id).toBe(proceedEvent.event_id);
  });

  it("marks oversized attachments as rejected without downloading and keeps the session event", async () => {
    const cfg = await makeTestConfig("felix-attachment-limit-");
    cfg.ATTACHMENT_MAX_BYTES = 10;
    const harnessInputs: TurnInput[] = [];
    const harness = makeRecordHarness(harnessInputs);
    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], harness);

    await engine.ingest({
      source: "mattermost",
      event_id: "big-attachment",
      thread_key: "mattermost:channel:big",
      received_at: "2026-05-25T00:01:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "user-a" },
      text: "@felix read this",
      attachments: [{ file_id: "file-1", filename: "large.pdf", size_bytes: 11 }],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "big-attachment.json"),
      source_thread_ref: mattermostThreadRef("channel", "big", "big-attachment"),
    });
    await engine.drain();

    expect(calls.downloadAttachment).not.toHaveBeenCalled();
    expect(harnessInputs).toHaveLength(1);
    expect(harnessInputs[0].event.attachments[0]).toMatchObject({
      filename: "large.pdf",
      status: "rejected",
    });
    expect(harnessInputs[0].event.attachments[0].rejected_reason).toContain("limit");
  });

});
