import { describe, expect, it } from "vitest";
import { applyProgressEvent, progressStateFromSnapshot, type ProgressClientState } from "../web/src/lib/progress-state.js";
import type { DashboardSnapshot, ProgressEvent } from "../web/src/lib/types.js";

const event: ProgressEvent = {
  threadKey: "mattermost:channel:root",
  harness: "opencode",
  attempt: 1,
  sequence: 1,
  at: "2026-07-20T12:00:00.000Z",
  phase: "thinking",
  status: "Thinking",
  elapsedMs: 1000,
};

describe("Owner progress SSE state", () => {
  it("uses a terminal tombstone so stale API progress cannot reappear", () => {
    const current = applyProgressEvent({ progressByThread: {}, terminalAttempts: {} }, event);
    const cleared = applyProgressEvent(current, { ...event, phase: "completed", sequence: 2 });

    expect(cleared.progressByThread[event.threadKey]).toBeNull();
    expect(progressStateFromSnapshot({ activeSessionList: [], } as unknown as DashboardSnapshot, cleared).progressByThread[event.threadKey]).toBeNull();
  });

  it("replaces a terminal tombstone when a new attempt starts", () => {
    const terminal: ProgressClientState = {
      progressByThread: { [event.threadKey]: null },
      terminalAttempts: { [event.threadKey]: { attempt: 1, sequence: 2 } },
    };
    const next = applyProgressEvent(terminal, { ...event, attempt: 2, sequence: 1, status: "Starting next turn" });

    expect(next.progressByThread[event.threadKey]).toMatchObject({ attempt: 2, status: "Starting next turn" });
  });

  it("rejects a late terminal event from an older attempt", () => {
    const terminal = applyProgressEvent(
      { progressByThread: {}, terminalAttempts: {} },
      { ...event, attempt: 2, sequence: 2, phase: "completed" },
    );
    const stale = applyProgressEvent(
      terminal,
      { ...event, attempt: 1, sequence: 9, phase: "failed" },
    );

    expect(stale).toEqual(terminal);
    expect(stale.terminalAttempts[event.threadKey]).toEqual({ attempt: 2, sequence: 2 });
  });

  it("does not let a stale snapshot resurrect terminal progress", () => {
    const terminal = applyProgressEvent(
      { progressByThread: {}, terminalAttempts: {} },
      { ...event, phase: "completed", sequence: 2 },
    );
    const snapshot = {
      activeSessionList: [{ threadKey: event.threadKey, currentProgress: event }],
    } as unknown as DashboardSnapshot;

    expect(progressStateFromSnapshot(snapshot, terminal).progressByThread[event.threadKey]).toBeNull();
  });

  it("does not replace a newer live event with an older snapshot", () => {
    const current = applyProgressEvent({ progressByThread: {}, terminalAttempts: {} }, {
      ...event,
      sequence: 3,
      status: "Newer phase",
    });
    const snapshot = {
      activeSessionList: [{ threadKey: event.threadKey, currentProgress: event }],
    } as unknown as DashboardSnapshot;

    expect(progressStateFromSnapshot(snapshot, current).progressByThread[event.threadKey]).toMatchObject({
      sequence: 3,
      status: "Newer phase",
    });
  });

  it("recovers progress from the complete snapshot map when a session is outside the display list", () => {
    const snapshot = {
      activeSessionList: [],
      currentProgressByThread: {
        [event.threadKey]: { ...event, sequence: 4, status: "Recovered progress" },
      },
    } as unknown as DashboardSnapshot;

    expect(progressStateFromSnapshot(snapshot, { progressByThread: {}, terminalAttempts: {} }).progressByThread[event.threadKey]).toMatchObject({
      sequence: 4,
      status: "Recovered progress",
    });
  });

  it("preserves newer live progress omitted from a delayed snapshot", () => {
    const live = {
      ...event,
      at: "2026-07-20T12:00:01.000Z",
      sequence: 2,
      status: "New turn started",
    };
    const snapshot = {
      at: "2026-07-20T12:00:00.000Z",
      activeSessionList: [],
      currentProgressByThread: {},
    } as unknown as DashboardSnapshot;

    expect(progressStateFromSnapshot(snapshot, {
      progressByThread: { [event.threadKey]: live },
      terminalAttempts: {},
    }).progressByThread[event.threadKey]).toEqual(live);
  });
});
