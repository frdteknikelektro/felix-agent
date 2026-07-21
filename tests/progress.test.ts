import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProgressStore } from "../src/slices/progress/index.js";
import { ProgressEventSchema } from "../src/core/schemas.js";

describe("ProgressStore", () => {
  it("writes ordered validated NDJSON lines with the default artifact writer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-progress-"));
    const artifactPath = path.join(dir, "turns", "progress.ndjson");
    const store = new ProgressStore();
    const reporter = store.createReporter({
      threadKey: "t",
      harness: "codex",
      attempt: 1,
      artifactPath,
      now: () => "2026-07-20T12:00:00.000Z",
    });

    reporter.emit({ phase: "started", status: "Starting" });
    reporter.emit({ phase: "thinking", status: "Thinking" });
    reporter.emit({ phase: "completed", status: "Done" });

    let raw = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      raw = await fs.readFile(artifactPath, "utf8").catch(() => "");
      if (raw.trim().split("\n").length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const events = raw.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; phase: string });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.phase)).toEqual(["started", "thinking", "completed"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

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

  it("allocates a fresh attempt after a completed turn", () => {
    const store = new ProgressStore(vi.fn(async () => undefined));
    const firstAttempt = store.beginAttempt("t");
    const first = store.createReporter({
      threadKey: "t",
      harness: "opencode",
      attempt: firstAttempt,
      artifactPath: "/thread/turns/progress.ndjson",
    });
    first.emit({ phase: "completed", status: "Done" });

    const secondAttempt = store.beginAttempt("t");
    const second = store.createReporter({
      threadKey: "t",
      harness: "opencode",
      attempt: secondAttempt,
      artifactPath: "/thread/turns/progress.ndjson",
    });
    second.emit({ phase: "started", status: "Starting next turn" });

    expect(secondAttempt).toBe(2);
    expect(store.current("t")).toMatchObject({ attempt: 2, phase: "started" });
  });

  it("defines the persisted event contract with the shared Zod schema", () => {
    expect(ProgressEventSchema.safeParse({
      threadKey: "t",
      harness: "codex",
      attempt: 1,
      sequence: 1,
      at: "2026-07-20T12:00:00.000Z",
      phase: "thinking",
      status: "Thinking",
      elapsedMs: 0,
    }).success).toBe(true);
    expect(ProgressEventSchema.safeParse({
      threadKey: "t",
      harness: "codex",
      attempt: 0,
      sequence: 1,
      at: "not-a-date",
      phase: "unknown",
      status: "Thinking",
    }).success).toBe(false);
  });

  it("keeps execution state healthy when artifact writing fails", async () => {
    const store = new ProgressStore(vi.fn(async () => {
      throw new Error("disk full");
    }));
    const reporter = store.createReporter({
      threadKey: "t",
      harness: "codex",
      attempt: store.beginAttempt("t"),
      artifactPath: "/thread/turns/progress.ndjson",
    });

    expect(() => reporter.emit({ phase: "thinking", status: "Still running" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.current("t")).toMatchObject({ status: "Still running" });
  });
});
