import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FelixEngine } from "../src/engine.js";
import { loadThreadState, loadSessionState, findThreadHandle } from "../src/slices/sessions/index.js";
import type { SourceAdapter, TurnInput, TurnResult } from "../src/core/ports.js";
import { buildOwnerPermissionNotification } from "../src/core/harness-common.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

function makeAdapter(calls: {
  sendThreadReply: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  editUserMessage: ReturnType<typeof vi.fn>;
  updateEventStatus: ReturnType<typeof vi.fn>;
  downloadAttachment: ReturnType<typeof vi.fn>;
  ownerUserId?: string;
  botUserId?: string;
}): SourceAdapter {
  return {
    source: "mattermost",
    botUserId: calls.botUserId,
    ownerUserId: calls.ownerUserId,
    getThreadLink: async () => undefined,
    getTurnContext: async () => ({ behaviorInstructions: [], owner: { display: "Owner" } }),
    updateEventStatus: async (input) => { calls.updateEventStatus(input); },
    sendTyping: async () => {},
    sendThreadReply: async (input) => { calls.sendThreadReply(input); },
    editUserMessage: async (input) => { calls.editUserMessage(input); },
    sendUserMessage: async (input) => { calls.sendUserMessage(input); return null; },
    downloadAttachment: async (input) => { calls.downloadAttachment(input); return input.attachment; },
    formatOwnerNotification: async (input) => buildOwnerPermissionNotification(input),
  };
}

function makeRecordHarness(inputs: TurnInput[]): { run: (input: TurnInput) => Promise<TurnResult> } {
  return {
    async run(input: TurnInput): Promise<TurnResult> {
      inputs.push(input);
      return {
        sessionId: `s${inputs.length}`,
        exitCode: 0,
        success: true,
        parsed: { kind: "reply", text: "ok" },
        logPath: "/dev/null",
      };
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

function seedThread(cfg: Awaited<ReturnType<typeof makeTestConfig>>, threadKey: string) {
  return {
    source: "mattermost",
    event_id: "seed",
    thread_key: threadKey,
    received_at: "2026-05-25T00:00:00.000Z",
    visibility: "channel" as const,
    mentions_bot: true,
    sender: { source: "mattermost", id: "owner-1" },
    text: "seed",
    attachments: [],
    raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "seed.json"),
    source_thread_ref: mattermostThreadRef("channel", "root", "seed"),
  };
}

describe("FelixEngine blocked-thread", () => {
  it("queues events on a blocked thread without calling the harness", async () => {
    const cfg = await makeTestConfig("felix-block-queue-");
    const harnessInputs: TurnInput[] = [];
    const harness = makeRecordHarness(harnessInputs);

    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      editUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], harness);

    const threadKey = "mattermost:channel:blocked";
    await engine.ingest({
      ...seedThread(cfg, threadKey),
      // Seed the thread via a real mention so it becomes managed.
    });
    await waitFor(() => harnessInputs.length >= 1);
    await engine.setBlocked(threadKey, true);

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-blocked",
      thread_key: threadKey,
      received_at: "2026-05-25T00:02:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "owner-1" },
      text: "hello after block",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "evt-blocked.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-blocked"),
    });

    // Give the queue a moment to settle — no harness call should happen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harnessInputs).toHaveLength(1); // only the seed triggered a turn

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const session = await loadSessionState(thread!);
    expect(session.queue.length).toBe(1);
    expect(session.queue[0]?.source_event_id).toBe("evt-blocked");
  });

  it("replays queued events when the thread is unblocked via setBlocked", async () => {
    const cfg = await makeTestConfig("felix-unblock-replay-");
    const harnessInputs: TurnInput[] = [];
    const harness = makeRecordHarness(harnessInputs);

    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      editUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], harness);

    const threadKey = "mattermost:channel:replay";
    await engine.ingest({ ...seedThread(cfg, threadKey) });
    await waitFor(() => harnessInputs.length >= 1);
    await engine.setBlocked(threadKey, true);

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-q-1",
      thread_key: threadKey,
      received_at: "2026-05-25T00:02:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "owner-1" },
      text: "queued 1",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "evt-q-1.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-q-1"),
    });
    await engine.ingest({
      source: "mattermost",
      event_id: "evt-q-2",
      thread_key: threadKey,
      received_at: "2026-05-25T00:03:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "owner-1" },
      text: "queued 2",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "evt-q-2.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-q-2"),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harnessInputs).toHaveLength(1);

    await engine.setBlocked(threadKey, false);

    // Drain is async — wait until both queued events are processed.
    for (let i = 0; i < 50 && harnessInputs.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(harnessInputs.map((input) => input.event.event_id)).toEqual([
      "seed",
      "evt-q-1",
      "evt-q-2",
    ]);
  });

  it("owner's /block chat command flips the flag and replies", async () => {
    const cfg = await makeTestConfig("felix-block-chat-");
    const harnessInputs: TurnInput[] = [];
    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      editUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
      ownerUserId: "owner-1",
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], makeRecordHarness(harnessInputs));

    const threadKey = "mattermost:channel:cmd-block";
    await engine.ingest({ ...seedThread(cfg, threadKey) });

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-cmd-block",
      thread_key: threadKey,
      received_at: "2026-05-25T00:02:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "owner-1" },
      text: "/block",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "evt-cmd-block.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-cmd-block"),
    });

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const state = await loadThreadState(thread!);
    expect(state.blocked).toBe(true);

    const replyText = calls.sendThreadReply.mock.calls
      .map((call) => call[0].text)
      .find((text) => text?.toLowerCase().includes("blocked"));
    expect(replyText).toBeTruthy();
  });

  it("non-owner /block attempt is silently ignored", async () => {
    const cfg = await makeTestConfig("felix-block-nonowner-");
    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      editUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
      ownerUserId: "owner-1",
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], new FakeHarness());

    const threadKey = "mattermost:channel:nonowner";
    await engine.ingest({ ...seedThread(cfg, threadKey) });

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-nonowner",
      thread_key: threadKey,
      received_at: "2026-05-25T00:02:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "random-user" },
      text: "/block",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "evt-nonowner.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-nonowner"),
    });

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const state = await loadThreadState(thread!);
    expect(state.blocked).toBeFalsy();
    // No chat reply — silent rejection.
    const replyTexts = calls.sendThreadReply.mock.calls.map((call) => call[0].text);
    expect(replyTexts.some((text) => text?.toLowerCase().includes("block"))).toBe(false);
  });

  it("owner's /unblock chat command clears the flag and drains the queue", async () => {
    const cfg = await makeTestConfig("felix-unblock-chat-");
    const harnessInputs: TurnInput[] = [];
    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      editUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
      ownerUserId: "owner-1",
    };
    const adapter = makeAdapter(calls);
    const engine = new FelixEngine(cfg, [adapter], makeRecordHarness(harnessInputs));

    const threadKey = "mattermost:channel:cmd-unblock";
    await engine.ingest({ ...seedThread(cfg, threadKey) });
    await waitFor(() => harnessInputs.length >= 1);
    await engine.setBlocked(threadKey, true);

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-during-block",
      thread_key: threadKey,
      received_at: "2026-05-25T00:02:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "owner-1" },
      text: "queued while blocked",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "evt-during-block.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-during-block"),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harnessInputs).toHaveLength(1);

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-unblock-cmd",
      thread_key: threadKey,
      received_at: "2026-05-25T00:03:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "owner-1" },
      text: "/unblock",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "evt-unblock-cmd.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-unblock-cmd"),
    });

    for (let i = 0; i < 50 && harnessInputs.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const state = await loadThreadState(thread!);
    expect(state.blocked).toBe(false);
    // The /unblock command itself does not invoke the harness; it sends a
    // chat reply and triggers drain. The harness is called for the two
    // queued events in arrival order.
    expect(harnessInputs.map((input) => input.event.event_id)).toEqual([
      "seed",
      "evt-during-block",
    ]);
    // The unblock command produced a chat reply.
    const replyTexts = calls.sendThreadReply.mock.calls.map((call) => call[0].text);
    expect(replyTexts.some((text) => text?.toLowerCase().includes("unblock"))).toBe(true);
  });
});
