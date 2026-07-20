import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { addDashboardClient, closeDashboardClients } from "../src/server/sse.js";
import { progressStore } from "../src/slices/progress/index.js";
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
});
