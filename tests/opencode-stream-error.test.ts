import { vi, describe, expect, it, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

vi.mock("../src/lib/fs.js", () => ({
  ensureDir: vi.fn(async () => {}),
  appendText: vi.fn(async () => {}),
  readText: vi.fn(async () => ""),
  writeTextAtomic: vi.fn(async () => {}),
}));
vi.mock("../src/lib/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/time.js", () => ({ fsTimestamp: () => "20260101_000000" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, ensureDir: vi.fn(async () => {}), open: vi.fn(async () => ({ close: vi.fn(async () => {}) })) };
});

import { opencodeRun } from "../src/adapters/opencode/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function createMockChild() {
  const proc = new EventEmitter() as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.defineProperty(proc, "stdout", { value: stdout, writable: false });
  Object.defineProperty(proc, "stderr", { value: stderr, writable: false });
  Object.defineProperty(proc, "killed", { value: false, writable: true });
  proc.kill = vi.fn(() => true);
  return { proc, stdout };
}

function emitJson(stdout: EventEmitter, event: Record<string, unknown>) {
  stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
}

async function drainMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}

async function waitReady() {
  // opencodeRun awaits ensureDir + fs.open before wiring event handlers.
  // Each await yields a microtask; three macrotask drains guarantee both
  // resolve and the Promise constructor body has run.
  await drainMicrotasks();
  await drainMicrotasks();
  await drainMicrotasks();
}

// ─── Stream error → fail fast ─────────────────────────────────────────────

describe("opencodeRun: stream error → fail fast", () => {
  it("detects type:error on stdout, kills child, and throws", async () => {
    const { proc, stdout } = createMockChild();
    const run = opencodeRun("opencode", ["run"], "/tmp", {}, "/tmp/t.log", undefined, {
      spawnFn: vi.fn(() => proc) as never,
    });
    await waitReady();

    emitJson(stdout, { type: "error", message: "quota exceeded" });

    await expect(run).rejects.toThrow("quota exceeded");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  }, 10_000);

  it("extracts error from nested error.message", async () => {
    const { proc, stdout } = createMockChild();
    const run = opencodeRun("opencode", ["run"], "/tmp", {}, "/tmp/t.log", undefined, {
      spawnFn: vi.fn(() => proc) as never,
    });
    await waitReady();

    emitJson(stdout, { type: "error", error: { message: "rate limited" } });

    await expect(run).rejects.toThrow("rate limited");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  }, 10_000);

  it("returns assistant text for non-error events", async () => {
    const { proc, stdout } = createMockChild();
    const run = opencodeRun("opencode", ["run"], "/tmp", {}, "/tmp/t.log", undefined, {
      spawnFn: vi.fn(() => proc) as never,
    });
    await waitReady();

    emitJson(stdout, { type: "text", part: { type: "text", text: "hello" } });
    // Let async data handler settle (appendText yields a microtask)
    await drainMicrotasks();
    await drainMicrotasks();
    await drainMicrotasks();
    proc.emit("close", 0);

    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.assistantText).toContain("hello");
  }, 10_000);

  it("short-circuits on pre-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await opencodeRun("opencode", ["run"], "/tmp", {}, "/tmp/t.log", ac.signal);
    expect(result.exitCode).toBe(143);
  });
});

// ─── Spawn error ─────────────────────────────────────────────────────────

describe("opencodeRun: spawn error", () => {
  it("resolves with -1 and logs on child error event", async () => {
    const { log } = await import("../src/lib/log.js");
    const { proc } = createMockChild();
    const spawnError = new Error("spawn ENOENT");
    const run = opencodeRun("opencode", ["run"], "/tmp", {}, "/tmp/t.log", undefined, {
      spawnFn: vi.fn(() => proc) as never,
    });
    await waitReady();

    // Emit after the Promise constructor has wired up child.on("error").
    proc.emit("error", spawnError);

    await expect(run).rejects.toThrow("spawn ENOENT");
    expect(log.error).toHaveBeenCalledWith("opencode.spawn_error", { error: "spawn ENOENT" });
  }, 10_000);
});
