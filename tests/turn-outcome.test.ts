import { describe, expect, it, vi } from "vitest";
import {
  formatCorrectionPrompt,
  handleTurnOutcome,
  handleTurnRunError,
  type TurnOutcomePorts,
} from "../src/core/turn-outcome.js";
import type { PermissionRequiredOutput, TurnResult } from "../src/core/ports.js";
import type { ThreadHandle } from "../src/slices/sessions/index.js";
import type { ContactRecord, SessionQueueItem, UniversalEvent } from "../src/types.js";

function makeThread(): ThreadHandle {
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
    session: { busy: false, queue: [], pending_permission: null },
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

function makeContact(allowed_permissions: string[] = []): ContactRecord {
  return {
    source: "mattermost",
    user_id: "user-1",
    allowed_permissions,
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

function makePorts(overrides: Partial<TurnOutcomePorts> = {}): TurnOutcomePorts {
  return {
    clearHarnessSession: vi.fn(async () => undefined),
    logUsage: vi.fn(async () => undefined),
    recordTurnWithUsage: vi.fn(async () => undefined),
    postThreadError: vi.fn(async () => undefined),
    postThreadReply: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => undefined),
    autoGrantPermission: vi.fn(async () => undefined),
    runFormatCorrection: vi.fn(async () => makeResult()),
    requeueEvent: vi.fn(async () => undefined),
    isStopRequested: vi.fn(() => false),
    clearStopRequested: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    ...overrides,
  };
}

async function runOutcome(input: {
  result: TurnResult;
  contact?: ContactRecord;
  resumed?: boolean;
  retriedFreshStart?: boolean;
  ports?: TurnOutcomePorts;
}) {
  const thread = makeThread();
  const event = makeEvent();
  const item = makeItem();
  const ports = input.ports ?? makePorts();
  const outcome = await handleTurnOutcome({
    thread,
    event,
    item,
    contact: input.contact ?? makeContact(),
    result: input.result,
    resumed: input.resumed ?? false,
    retriedFreshStart: input.retriedFreshStart ?? false,
    retryCounts: new Map(),
    ports,
  });
  return { outcome, ports, thread, event, item };
}

describe("handleTurnOutcome", () => {
  it.each([
    ["reply", makeResult({ parsed: { kind: "reply", text: "hello" } }), "hello"],
    ["fallback", makeResult({ parsed: { kind: "unknown", text: "raw text" } }), "raw text"],
    ["no_skill", makeResult({ parsed: { kind: "no_skill", text: "I don't have the skill yet." } }), "I don't have the skill yet."],
  ])("%s records the turn and posts parsed text", async (_name, result, expectedText) => {
    const { outcome, ports, thread, event } = await runOutcome({ result });

    expect(outcome.kind).toBe("complete");
    expect(ports.recordTurnWithUsage).toHaveBeenCalledWith(thread, event, result);
    expect(ports.postThreadReply).toHaveBeenCalledWith(thread, event, result.sessionId, expectedText);
  });

  it("clears a failed resumed session and posts the same exit-code error detail", async () => {
    const result = makeResult({ success: false, exitCode: 127 });
    const { outcome, ports, thread, event } = await runOutcome({
      result,
      resumed: true,
      retriedFreshStart: true,
    });

    expect(outcome.kind).toBe("complete");
    expect(ports.clearHarnessSession).toHaveBeenCalledWith(thread);
    expect(ports.postThreadError).toHaveBeenCalledWith(thread, event, "The agent binary was not found. ");
    expect(ports.error).toHaveBeenCalledWith("harness.empty_output", expect.objectContaining({ exit_code: 127 }));
  });

  it("returns retry_fresh after a first resumed failure", async () => {
    const result = makeResult({ success: false, exitCode: 1 });
    const { outcome, ports, thread } = await runOutcome({ result, resumed: true });

    expect(outcome).toEqual({ kind: "retry_fresh", resumed: false, retriedFreshStart: true });
    expect(ports.clearHarnessSession).toHaveBeenCalledWith(thread);
    expect(ports.warn).toHaveBeenCalledWith("harness.resume_fallback", expect.objectContaining({ exit_code: 1 }));
  });

  it("records malformed-attempt usage and applies the corrected result", async () => {
    const malformed = makeResult({
      sessionId: "bad-session",
      parsed: { kind: "format_error", text: "missing permissions" },
    });
    const corrected = makeResult({
      sessionId: "good-session",
      parsed: { kind: "reply", text: "fixed" },
    });
    const ports = makePorts({
      runFormatCorrection: vi.fn(async () => corrected),
    });
    const { outcome, thread, event } = await runOutcome({ result: malformed, ports });

    expect(outcome.kind).toBe("complete");
    expect(ports.logUsage).toHaveBeenCalledWith(thread, event, malformed);
    expect(ports.runFormatCorrection).toHaveBeenCalledWith(formatCorrectionPrompt("missing permissions"));
    expect(ports.recordTurnWithUsage).toHaveBeenCalledWith(thread, event, corrected);
    expect(ports.postThreadReply).toHaveBeenCalledWith(thread, event, "good-session", "fixed");
  });

  it("requests only missing bare permissions", async () => {
    const parsed: PermissionRequiredOutput = {
      kind: "permission_required",
      text: "Need permission",
      skillId: "deploy",
      permissions: ["shell.run", "net.fetch"],
      reason: "deploy needs access",
      ownerMessage: "approve deploy",
    };
    const result = makeResult({ parsed });
    const { outcome, ports, thread, event } = await runOutcome({
      result,
      contact: makeContact(["deploy:shell.run"]),
    });

    expect(outcome.kind).toBe("complete");
    expect(ports.postThreadReply).toHaveBeenCalledWith(thread, event, result.sessionId, "Need permission");
    expect(ports.requestPermission).toHaveBeenCalledWith(thread, event, {
      ...parsed,
      permissions: ["net.fetch"],
    });
    expect(ports.autoGrantPermission).not.toHaveBeenCalled();
  });

  it("auto-grants when every requested permission is already allowed", async () => {
    const parsed: PermissionRequiredOutput = {
      kind: "permission_required",
      text: "Need permission",
      skillId: "deploy",
      permissions: ["shell.run"],
      reason: "deploy needs access",
      ownerMessage: "approve deploy",
    };
    const result = makeResult({ parsed });
    const { outcome, ports, thread, event } = await runOutcome({
      result,
      contact: makeContact(["deploy:shell.run"]),
    });

    expect(outcome.kind).toBe("complete");
    expect(ports.autoGrantPermission).toHaveBeenCalledWith(thread, event, result.sessionId);
    expect(ports.requestPermission).not.toHaveBeenCalled();
  });

  it("treats repeated malformed correction output as unusable output", async () => {
    const malformed = makeResult({
      parsed: { kind: "format_error", text: "missing permissions" },
    });
    const stillMalformed = makeResult({
      parsed: { kind: "format_error", text: "still missing permissions" },
    });
    const ports = makePorts({
      runFormatCorrection: vi.fn(async () => stillMalformed),
    });
    const { outcome, thread, event } = await runOutcome({ result: malformed, ports, resumed: true });

    expect(outcome.kind).toBe("complete");
    expect(ports.clearHarnessSession).toHaveBeenCalledWith(thread);
    expect(ports.postThreadError).toHaveBeenCalledWith(thread, event, "The agent produced no usable output. ");
  });
});

describe("handleTurnRunError", () => {
  it("requeues the event and posts the thrown error detail before the retry limit", async () => {
    const thread = makeThread();
    const event = makeEvent();
    const item = makeItem();
    const ports = makePorts();
    const retryCounts = new Map<string, number>();

    const outcome = await handleTurnRunError({
      thread,
      event,
      item,
      error: new Error("boom"),
      retryCounts,
      ports,
    });

    expect(outcome.kind).toBe("complete");
    expect(retryCounts.get(item.source_event_id)).toBe(1);
    expect(ports.requeueEvent).toHaveBeenCalledWith(thread, item);
    expect(ports.postThreadError).toHaveBeenCalledWith(thread, event, "boom. ");
  });
});
