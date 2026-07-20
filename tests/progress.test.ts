import { describe, expect, it, vi } from "vitest";
import { ProgressStore } from "../src/slices/progress/index.js";

describe("ProgressStore", () => {
  it("publishes ordered redacted events, writes the CLI artifact, and clears terminal state", async () => {
    const writeArtifact = vi.fn(async () => undefined);
    const store = new ProgressStore(writeArtifact);
    const received: string[] = [];
    store.subscribe((event) => received.push(event.phase));

    const reporter = store.createReporter({
      threadKey: "mattermost:channel:root",
      harness: "opencode",
      attempt: 1,
      sessionId: "session-1",
      artifactPath: "/thread/turns/progress.ndjson",
      now: () => "2026-07-20T12:00:00.000Z",
    });

    reporter.emit({ phase: "started", status: "Starting harness" });
    reporter.emit({ phase: "tool_started", status: "Running git", tool: "git" });
    reporter.emit({ phase: "completed", status: "Completed" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual(["started", "tool_started", "completed"]);
    expect(store.current("mattermost:channel:root")).toBeUndefined();
    expect(writeArtifact).toHaveBeenCalledTimes(3);
    expect(writeArtifact).toHaveBeenLastCalledWith(
      "/thread/turns/progress.ndjson",
      expect.objectContaining({
        threadKey: "mattermost:channel:root",
        sessionId: "session-1",
        attempt: 1,
        sequence: 3,
        phase: "completed",
      }),
    );
  });

  it("does not allow an older attempt to replace the current attempt", () => {
    const store = new ProgressStore(vi.fn(async () => undefined));
    const first = store.createReporter({
      threadKey: "t",
      harness: "codex",
      attempt: 1,
      artifactPath: "/thread/turns/progress.ndjson",
    });
    const second = store.createReporter({
      threadKey: "t",
      harness: "codex",
      attempt: 2,
      artifactPath: "/thread/turns/progress.ndjson",
    });

    first.emit({ phase: "started", status: "Attempt one" });
    second.emit({ phase: "started", status: "Attempt two" });
    first.emit({ phase: "thinking", status: "Stale attempt" });

    expect(store.current("t")).toMatchObject({ attempt: 2, status: "Attempt two" });
  });

  it("sanitizes line breaks and bounds live status text", () => {
    const store = new ProgressStore(vi.fn(async () => undefined));
    const reporter = store.createReporter({
      threadKey: "t",
      harness: "claude-code",
      attempt: 1,
      artifactPath: "/thread/turns/progress.ndjson",
    });

    reporter.emit({ phase: "thinking", status: "line one\nline two\r" + "x".repeat(500) });

    const event = store.current("t");
    expect(event?.status).not.toMatch(/[\r\n]/);
    expect(event?.status.length).toBeLessThanOrEqual(240);
  });

  it("ignores late events from a terminal attempt", () => {
    const store = new ProgressStore(vi.fn(async () => undefined));
    const reporter = store.createReporter({
      threadKey: "t",
      harness: "opencode",
      attempt: 1,
      artifactPath: "/thread/turns/progress.ndjson",
    });

    reporter.emit({ phase: "completed", status: "Done" });
    reporter.emit({ phase: "thinking", status: "Late provider event" });

    expect(store.current("t")).toBeUndefined();
  });
});
