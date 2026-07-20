import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { FelixEngine } from "../src/engine.js";
import {
  loadThreadState,
  loadSessionState,
  findThreadHandle,
} from "../src/slices/sessions/index.js";
import type { SourceAdapter } from "../src/core/ports.js";
import { buildOwnerPermissionNotification } from "../src/core/harness-common.js";
import { FakeHarness, RecordHarness } from "./helpers/fake-harness.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

type Calls = {
  sendThreadReply: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  editUserMessage: ReturnType<typeof vi.fn>;
  updateEventStatus: ReturnType<typeof vi.fn>;
  downloadAttachment: ReturnType<typeof vi.fn>;
};

function makeAdapter(
  calls: Calls,
  ownerUserId?: string,
  downloadAttachment?: SourceAdapter["downloadAttachment"],
): SourceAdapter {
  return {
    source: "mattermost",
    botUserId: undefined,
    ownerUserId,
    getThreadLink: async () => undefined,
    getTurnContext: async () => ({
      behaviorInstructions: [],
      owner: { display: "Owner" },
    }),
    updateEventStatus: async (input) => {
      calls.updateEventStatus(input);
    },
    sendTyping: async () => {},
    sendThreadReply: async (input) => {
      calls.sendThreadReply(input);
    },
    editUserMessage: async (input) => {
      calls.editUserMessage(input);
    },
    sendUserMessage: async (input) => {
      calls.sendUserMessage(input);
      return null;
    },
    downloadAttachment: async (input) => {
      calls.downloadAttachment(input);
      if (downloadAttachment) return downloadAttachment(input);
      return input.attachment;
    },
    formatOwnerNotification: async (input) =>
      buildOwnerPermissionNotification(input),
  };
}

function freshCalls(): Calls {
  return {
    sendThreadReply: vi.fn(),
    sendUserMessage: vi.fn(),
    editUserMessage: vi.fn(),
    updateEventStatus: vi.fn(),
    downloadAttachment: vi.fn(),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

function seedThread(
  cfg: Awaited<ReturnType<typeof makeTestConfig>>,
  threadKey: string,
) {
  return {
    source: "mattermost" as const,
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

function eventAfterBlock(
  cfg: Awaited<ReturnType<typeof makeTestConfig>>,
  threadKey: string,
  eventId: string,
  text: string,
) {
  return {
    source: "mattermost" as const,
    event_id: eventId,
    thread_key: threadKey,
    received_at: "2026-05-25T00:02:00.000Z",
    visibility: "channel" as const,
    mentions_bot: true,
    sender: { source: "mattermost", id: "owner-1" },
    text,
    attachments: [],
    raw_path: path.join(
      cfg.paths.intake,
      "mattermost",
      "raw",
      `${eventId}.json`,
    ),
    source_thread_ref: mattermostThreadRef("channel", "root", eventId),
  };
}

describe("FelixEngine blocked-thread", () => {
  it("queues events on a blocked thread without calling the harness", async () => {
    const cfg = await makeTestConfig("felix-block-queue-");
    const harness = new RecordHarness();
    const calls = freshCalls();
    const engine = new FelixEngine(cfg, [makeAdapter(calls)], harness);

    const threadKey = "mattermost:channel:blocked";
    await engine.ingest(seedThread(cfg, threadKey));
    await waitFor(() => harness.inputs.length >= 1);
    await engine.setBlocked(threadKey, true);

    await engine.ingest(
      eventAfterBlock(cfg, threadKey, "evt-blocked", "hello after block"),
    );

    // No second harness call should arrive — give the queue a chance to settle.
    await waitFor(() => harness.inputs.length >= 2, 200).catch(() => undefined);
    expect(harness.inputs).toHaveLength(1);

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const session = await loadSessionState(thread!);
    expect(session.queue.map((item) => item.source_event_id)).toEqual([
      "evt-blocked",
    ]);
    expect(
      calls.updateEventStatus.mock.calls.filter(
        ([input]) => input.event.event_id === "evt-blocked",
      ),
    ).toHaveLength(0);
  });

  it("serializes blocking with an event already being ingested", async () => {
    const cfg = await makeTestConfig("felix-block-race-");
    const calls = freshCalls();
    let signalDownloadStarted!: () => void;
    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      signalDownloadStarted = resolve;
    });
    const downloadReleased = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const engine = new FelixEngine(
      cfg,
      [
        makeAdapter(calls, undefined, async (input) => {
          signalDownloadStarted();
          await downloadReleased;
          return input.attachment;
        }),
      ],
      new FakeHarness(),
    );
    const threadKey = "mattermost:channel:block-race";
    await engine.ingest(seedThread(cfg, threadKey));
    await engine.drain();

    const event = {
      ...eventAfterBlock(cfg, threadKey, "evt-race", "during race"),
      attachments: [{ file_id: "file-race", filename: "race.txt" }],
    };
    const ingestPromise = engine.ingest(event);
    await downloadStarted;
    const blockPromise = engine.setBlocked(threadKey, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseDownload();
    await Promise.all([ingestPromise, blockPromise]);

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    expect((await loadThreadState(thread!)).blocked).toBe(true);
  });

  it("deduplicates a redelivered event while the thread is blocked", async () => {
    const cfg = await makeTestConfig("felix-block-dedupe-");
    const calls = freshCalls();
    const engine = new FelixEngine(
      cfg,
      [makeAdapter(calls)],
      new FakeHarness(),
    );
    const threadKey = "mattermost:channel:dedupe";
    await engine.ingest(seedThread(cfg, threadKey));
    await engine.drain();
    await engine.setBlocked(threadKey, true);

    const event = eventAfterBlock(
      cfg,
      threadKey,
      "evt-redelivered",
      "redelivered",
    );
    await engine.ingest(event);
    await engine.ingest({ ...event });

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const session = await loadSessionState(thread!);
    expect(session.queue.map((item) => item.source_event_id)).toEqual([
      "evt-redelivered",
    ]);
    const eventFiles = await fs.readdir(thread!.eventsDir);
    expect(
      eventFiles.filter((file) => file.includes("evt-redelivered")).length,
    ).toBe(1);
  });

  it("replays queued events in arrival order when the thread is unblocked via setBlocked", async () => {
    const cfg = await makeTestConfig("felix-unblock-replay-");
    const harness = new RecordHarness();
    const calls = freshCalls();
    const engine = new FelixEngine(cfg, [makeAdapter(calls)], harness);

    const threadKey = "mattermost:channel:replay";
    await engine.ingest(seedThread(cfg, threadKey));
    await waitFor(() => harness.inputs.length >= 1);
    await engine.setBlocked(threadKey, true);

    await engine.ingest(eventAfterBlock(cfg, threadKey, "evt-q-1", "queued 1"));
    await engine.ingest(eventAfterBlock(cfg, threadKey, "evt-q-2", "queued 2"));

    // Confirm blocked: no new harness calls beyond the seed.
    await waitFor(() => harness.inputs.length >= 3, 200).catch(() => undefined);
    expect(harness.inputs).toHaveLength(1);

    await engine.setBlocked(threadKey, false);
    await waitFor(() => harness.inputs.length >= 3);

    expect(harness.inputs.map((input) => input.event.event_id)).toEqual([
      "seed",
      "evt-q-1",
      "evt-q-2",
    ]);
  });

  it("owner's /block chat command flips the flag and replies", async () => {
    const cfg = await makeTestConfig("felix-block-chat-");
    const calls = freshCalls();
    const engine = new FelixEngine(
      cfg,
      [makeAdapter(calls, "owner-1")],
      new FakeHarness(),
    );

    const threadKey = "mattermost:channel:cmd-block";
    await engine.ingest(seedThread(cfg, threadKey));

    await engine.ingest({
      ...eventAfterBlock(cfg, threadKey, "evt-cmd-block", "/block"),
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

  it("owner's /unblock chat command clears the flag and drains the queue", async () => {
    const cfg = await makeTestConfig("felix-unblock-chat-");
    const harness = new RecordHarness();
    const calls = freshCalls();
    const engine = new FelixEngine(
      cfg,
      [makeAdapter(calls, "owner-1")],
      harness,
    );

    const threadKey = "mattermost:channel:cmd-unblock";
    await engine.ingest(seedThread(cfg, threadKey));
    await waitFor(() => harness.inputs.length >= 1);
    await engine.setBlocked(threadKey, true);

    await engine.ingest(
      eventAfterBlock(
        cfg,
        threadKey,
        "evt-during-block",
        "queued while blocked",
      ),
    );
    await waitFor(() => harness.inputs.length >= 2, 200).catch(() => undefined);
    expect(harness.inputs).toHaveLength(1);

    await engine.ingest({
      ...eventAfterBlock(cfg, threadKey, "evt-unblock-cmd", "/unblock"),
    });
    await waitFor(() => harness.inputs.length >= 2);

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const state = await loadThreadState(thread!);
    expect(state.blocked).toBe(false);
    // The /unblock command itself does not invoke the harness; only the
    // two queued source events drain.
    expect(harness.inputs.map((input) => input.event.event_id)).toEqual([
      "seed",
      "evt-during-block",
    ]);
    // The unblock command produced a chat reply.
    const replyTexts = calls.sendThreadReply.mock.calls.map(
      (call) => call[0].text,
    );
    expect(
      replyTexts.some((text) => text?.toLowerCase().includes("unblock")),
    ).toBe(true);
  });

  it("non-owner /block and /unblock attempts are silently ignored", async () => {
    const cfg = await makeTestConfig("felix-block-nonowner-");
    const harness = new RecordHarness();
    const calls = freshCalls();
    const engine = new FelixEngine(
      cfg,
      [makeAdapter(calls, "owner-1")],
      harness,
    );

    const threadKey = "mattermost:channel:nonowner";
    await engine.ingest(seedThread(cfg, threadKey));
    await waitFor(() => harness.inputs.length >= 1);

    for (const [eventId, text] of [
      ["evt-nonowner-block", "/block"],
      ["evt-nonowner-unblock", "/unblock"],
    ] as const) {
      await engine.ingest({
        ...eventAfterBlock(cfg, threadKey, eventId, text),
        sender: { source: "mattermost", id: "random-user" },
      });
    }

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const state = await loadThreadState(thread!);
    expect(state.blocked).toBeFalsy();
    // No chat reply — silent rejection.
    const replyTexts = calls.sendThreadReply.mock.calls.map(
      (call) => call[0].text,
    );
    expect(
      replyTexts.some((text) => text?.toLowerCase().includes("block")),
    ).toBe(false);
  });

  it("setBlocked creates a brand-new thread stub for a previously-unseen thread key", async () => {
    const cfg = await makeTestConfig("felix-block-new-");
    const calls = freshCalls();
    const engine = new FelixEngine(
      cfg,
      [makeAdapter(calls)],
      new FakeHarness(),
    );

    const threadKey = "mattermost:channel:brand-new";
    // The thread does not exist yet — REST pre-emptive block should
    // create a stub rather than 404.
    await engine.setBlocked(threadKey, true);

    const thread = await findThreadHandle(cfg, threadKey);
    expect(thread).not.toBeNull();
    const state = await loadThreadState(thread!);
    expect(state.blocked).toBe(true);
    expect(state.source).toBe("mattermost");
  });

  it("rejects path-bearing thread keys before creating a thread", async () => {
    const cfg = await makeTestConfig("felix-block-invalid-key-");
    const engine = new FelixEngine(cfg, [], new FakeHarness());

    await expect(engine.setBlocked("../outside:thread", true)).rejects.toThrow(
      "Invalid thread key",
    );
    await expect(fs.stat(cfg.paths.sessions)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
