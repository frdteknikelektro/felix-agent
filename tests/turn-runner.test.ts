import { describe, expect, it, vi } from "vitest";
import { TurnRunner, type TurnRunnerPorts } from "../src/core/turn-runner.js";
import type { Harness, SourceTurnContext, TurnInput, TurnResult } from "../src/core/ports.js";
import type { ThreadHandle } from "../src/slices/sessions/index.js";
import type { ContactRecord, SessionQueueItem, SessionState, SkillRecord, UniversalEvent } from "../src/types.js";

function makeThread(session: SessionState = { busy: false, queue: [], pending_permission: null }): ThreadHandle {
  return {
    dir: "/tmp/thread",
    threadFile: "/tmp/thread/thread.json",
    sessionFile: "/tmp/thread/session.json",
    transcriptFile: "/tmp/thread/transcript.md",
    eventsDir: "/tmp/thread/events",
    attachmentsDir: "/tmp/thread/attachments",
    turnsDir: "/tmp/thread/turns",
    state: {
      thread_key: "mattermost:channel:root",
      source: "mattermost",
      created_at: "2026-05-25T00:00:00.000Z",
      updated_at: "2026-05-25T00:00:00.000Z",
      managed_by_felix: true,
      source_thread_ref: { source: "mattermost", conversation_id: "channel", root_message_id: "root" },
      participants: [],
    },
    session,
  };
}

function makeEvent(): UniversalEvent {
  return {
    source: "mattermost",
    event_id: "event-1",
    thread_key: "mattermost:channel:root",
    received_at: "2026-05-25T00:01:00.000Z",
    visibility: "channel",
    mentions_bot: true,
    sender: { source: "mattermost", id: "user-1" },
    text: "@felix do it",
    attachments: [],
    raw_path: "/tmp/raw.json",
    source_thread_ref: { source: "mattermost", conversation_id: "channel", root_message_id: "root", message_id: "event-1" },
  };
}

function makeItem(): SessionQueueItem {
  return {
    received_at: "2026-05-25T00:01:00.000Z",
    event_file: "/tmp/thread/events/event.md",
    source_event_id: "event-1",
  };
}

function makeContact(): ContactRecord {
  return {
    source: "mattermost",
    user_id: "user-1",
    allowed_permissions: [],
  };
}

function makeResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "session-1",
    exitCode: 0,
    success: true,
    parsed: { kind: "reply", text: "ok" },
    logPath: "/dev/null",
    ...overrides,
  };
}

function makePorts(sourceContext: SourceTurnContext = { behaviorInstructions: ["source rule"] }): TurnRunnerPorts {
  return {
    sourceAdapter: vi.fn(() => ({
      getTurnContext: vi.fn(async () => sourceContext),
      sendTyping: vi.fn(async () => undefined),
    })),
    clearHarnessSession: vi.fn(async () => undefined),
    logUsage: vi.fn(async () => undefined),
    recordTurnWithUsage: vi.fn(async () => undefined),
    postThreadError: vi.fn(async () => undefined),
    postThreadReply: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => undefined),
    autoGrantPermission: vi.fn(async () => undefined),
    requeueEvent: vi.fn(async () => undefined),
    isStopRequested: vi.fn(() => false),
    clearStopRequested: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
  };
}

function makeInput(overrides: Partial<{
  thread: ThreadHandle;
  session: SessionState;
  precedingEvents: { event: UniversalEvent; eventFile: string }[];
  contact: ContactRecord;
  skills: SkillRecord[];
  retryCounts: Map<string, number>;
}> = {}) {
  const session = overrides.session ?? { busy: false, queue: [], pending_permission: null };
  return {
    thread: overrides.thread ?? makeThread(session),
    item: makeItem(),
    session,
    event: makeEvent(),
    precedingEvents: overrides.precedingEvents ?? [],
    contact: overrides.contact ?? makeContact(),
    skills: overrides.skills ?? [],
    signal: new AbortController().signal,
    retryCounts: overrides.retryCounts ?? new Map<string, number>(),
  };
}

describe("TurnRunner", () => {
  it("runs one trigger with source context and delegates successful outcome", async () => {
    const inputs: TurnInput[] = [];
    const harness: Harness = {
      run: vi.fn(async (input) => {
        inputs.push(input);
        return makeResult({ parsed: { kind: "reply", text: "done" } });
      }),
    };
    const ports = makePorts();
    const preceding = [{ event: makeEvent(), eventFile: "/tmp/thread/events/previous.md" }];
    const runner = new TurnRunner(harness, ports);

    const result = await runner.run(makeInput({ precedingEvents: preceding }));

    expect(result).toEqual({ kind: "complete" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].sourceContext.behaviorInstructions).toEqual(["source rule"]);
    expect(inputs[0].precedingEvents).toEqual(preceding);
    expect(inputs[0].resumed).toBe(false);
    expect(ports.recordTurnWithUsage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ sessionId: "session-1" }));
    expect(ports.postThreadReply).toHaveBeenCalledWith(expect.anything(), expect.anything(), "session-1", "done");
  });

  it("retries fresh when a resumed harness attempt fails once", async () => {
    const inputs: TurnInput[] = [];
    const harness: Harness = {
      run: vi.fn(async (input) => {
        inputs.push(input);
        return inputs.length === 1
          ? makeResult({ success: false, exitCode: 1, sessionId: "old-session" })
          : makeResult({ sessionId: "new-session", parsed: { kind: "reply", text: "fresh" } });
      }),
    };
    const ports = makePorts();
    const session: SessionState = { busy: false, queue: [], pending_permission: null, harness_session_id: "old-session" };
    const runner = new TurnRunner(harness, ports);

    const result = await runner.run(makeInput({ session }));

    expect(result).toEqual({ kind: "complete" });
    expect(inputs.map((input) => input.resumed)).toEqual([true, false]);
    expect(ports.clearHarnessSession).toHaveBeenCalledTimes(1);
    expect(ports.warn).toHaveBeenCalledWith("harness.resume_fallback", expect.objectContaining({ exit_code: 1 }));
    expect(ports.postThreadReply).toHaveBeenCalledWith(expect.anything(), expect.anything(), "new-session", "fresh");
  });

  it("hands harness run errors to Turn outcome retry handling", async () => {
    const harness: Harness = {
      run: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const ports = makePorts();
    const retryCounts = new Map<string, number>();
    const input = makeInput({ retryCounts });
    const runner = new TurnRunner(harness, ports);

    const result = await runner.run(input);

    expect(result).toEqual({ kind: "complete" });
    expect(retryCounts.get(input.item.source_event_id)).toBe(1);
    expect(ports.requeueEvent).toHaveBeenCalledWith(input.thread, input.item);
    expect(ports.postThreadError).toHaveBeenCalledWith(input.thread, input.event, "boom. ");
  });
});
