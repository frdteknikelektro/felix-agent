import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnRunner, type TurnRunnerPorts } from "../src/core/turn-runner.js";
import type { Harness, TurnInput, TurnResult } from "../src/core/ports.js";
import type { ThreadHandle } from "../src/slices/sessions/index.js";
import type { SessionState } from "../src/types.js";
import { addDashboardClient, closeDashboardClients } from "../src/server/sse.js";
import { ProgressStore, progressStore } from "../src/slices/progress/index.js";
import { makeTestConfig } from "./helpers/workspace.js";

describe("progress SSE", () => {
  afterEach(() => closeDashboardClients());

  it("sends current and live progress events to an owner client", async () => {
    const cfg = await makeTestConfig("felix-progress-sse-");
    const threadKey = `mattermost:channel:sse-${Date.now()}`;
    const reporter = progressStore.createReporter({
      threadKey,
      harness: "opencode",
      attempt: 1,
      artifactPath: `${cfg.paths.root}/progress.ndjson`,
    });
    reporter.emit({ phase: "thinking", status: "Thinking" });

    const req = new EventEmitter();
    const writes: string[] = [];
    const res = new EventEmitter() as EventEmitter & {
      writeHead: (...args: unknown[]) => void;
      write: (chunk: string) => void;
      end: () => void;
    };
    res.writeHead = () => undefined;
    res.write = (chunk) => writes.push(chunk);
    res.end = () => undefined;

    addDashboardClient(cfg, req as never, res as never);
    reporter.emit({ phase: "tool_started", status: "Running git", tool: "git" });

    expect(writes.some((write) => write.includes("event: progress") && write.includes('"status":"Thinking"'))).toBe(true);
    expect(writes.some((write) => write.includes('"status":"Running git"'))).toBe(true);

    reporter.emit({ phase: "completed", status: "Done" });
    req.emit("close");
  });

  it("does not miss progress emitted during initial replay", async () => {
    const cfg = await makeTestConfig("felix-progress-sse-race-");
    const store = new ProgressStore(vi.fn(async () => undefined));
    const reporter = store.createReporter({
      threadKey: `mattermost:channel:sse-race-${Date.now()}`,
      harness: "opencode",
      attempt: 1,
      artifactPath: `${cfg.paths.root}/progress.ndjson`,
    });
    reporter.emit({ phase: "thinking", status: "First" });

    const req = new EventEmitter();
    const writes: string[] = [];
    let emittedDuringReplay = false;
    const res = new EventEmitter() as EventEmitter & {
      writeHead: (...args: unknown[]) => void;
      write: (chunk: string) => void;
      end: () => void;
    };
    res.writeHead = () => undefined;
    res.write = (chunk) => {
      writes.push(chunk);
      if (!emittedDuringReplay && chunk.includes('"status":"First"')) {
        emittedDuringReplay = true;
        reporter.emit({ phase: "tool_started", status: "Second", tool: "git" });
      }
    };
    res.end = () => undefined;

    addDashboardClient(cfg, req as never, res as never, { progressSource: store });

    expect(writes.some((write) => write.includes('"status":"Second"'))).toBe(true);
    req.emit("close");
  });

  it("delivers TurnRunner progress through the store to SSE", async () => {
    const cfg = await makeTestConfig("felix-progress-sse-integration-");
    const store = new ProgressStore(vi.fn(async () => undefined));
    const threadKey = `mattermost:channel:sse-integration-${Date.now()}`;
    const session = { busy: false, queue: [], pending_permission: null } as unknown as SessionState;
    const thread = {
      state: { thread_key: threadKey },
      session,
    } as unknown as ThreadHandle;
    const event = { source: "mattermost" } as never;
    const result: TurnResult = {
      sessionId: "session-1",
      exitCode: 0,
      success: true,
      parsed: { kind: "reply", text: "done" },
      logPath: "/tmp/turn.log",
    };
    const harness: Harness = { run: vi.fn(async (_input: TurnInput) => result) };
    const ports: TurnRunnerPorts = {
      sourceAdapter: vi.fn(() => ({
        getTurnContext: vi.fn(async () => ({ behaviorInstructions: [] })),
        sendTyping: vi.fn(async () => undefined),
      })),
      progressReporter: vi.fn(() => store.createReporter({
        threadKey,
        harness: "opencode",
        attempt: store.beginAttempt(threadKey),
        artifactPath: `${cfg.paths.root}/progress.ndjson`,
      })),
      clearHarnessSession: vi.fn(async () => undefined),
      logUsage: vi.fn(async () => undefined),
      recordTurnWithUsage: vi.fn(async () => undefined),
      postThreadError: vi.fn(async () => undefined),
      postThreadReply: vi.fn(async () => undefined),
      requestPermission: vi.fn(async () => undefined),
      autoGrantPermission: vi.fn(async () => undefined),
      stagePersonalityProposal: vi.fn(async () => "Personality change proposed."),
      requeueEvent: vi.fn(async () => undefined),
      isStopRequested: vi.fn(() => false),
      clearStopRequested: vi.fn(() => undefined),
      warn: vi.fn(() => undefined),
      error: vi.fn(() => undefined),
    };
    const runner = new TurnRunner(harness, ports);
    const req = new EventEmitter();
    const writes: string[] = [];
    const res = new EventEmitter() as EventEmitter & {
      writeHead: (...args: unknown[]) => void;
      write: (chunk: string) => void;
      end: () => void;
    };
    res.writeHead = () => undefined;
    res.write = (chunk) => writes.push(chunk);
    res.end = () => undefined;

    addDashboardClient(cfg, req as never, res as never, { progressSource: store });
    await runner.run({
      thread,
      session,
      event,
      precedingEvents: [],
      contact: {} as never,
      skills: [],
      signal: new AbortController().signal,
      retryCounts: new Map(),
      item: {
        received_at: "2026-07-21T00:00:00.000Z",
        source_event_id: "event-1",
        event_file: "/tmp/event.md",
      },
    });

    expect(writes.some((write) => write.includes('"status":"Starting harness turn"'))).toBe(true);
    expect(writes.some((write) => write.includes('"status":"Turn completed"'))).toBe(true);
    req.emit("close");
  });
});
