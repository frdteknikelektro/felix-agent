import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FelixEngine } from "../src/engine.js";
import type {
  Harness,
  SourceAdapter,
  TurnInput,
  TurnResult,
} from "../src/core/ports.js";
import { saveContact } from "../src/slices/contacts/index.js";
import { stopMemoryCron } from "../src/slices/memory/index.js";
import { stopScheduler, tick } from "../src/slices/scheduler/index.js";
import { SchedulerJobSchema } from "../src/slices/scheduler/schemas.js";
import { writeJsonAtomic } from "../src/lib/fs.js";
import { makeTestConfig } from "./helpers/workspace.js";

function makeAdapter(calls: {
  sendThreadReply: ReturnType<typeof vi.fn>;
  updateEventStatus: ReturnType<typeof vi.fn>;
}): SourceAdapter {
  return {
    source: "mattermost",
    getThreadLink: async () => undefined,
    getTurnContext: async () => ({ behaviorInstructions: [] }),
    updateEventStatus: async (input) => {
      calls.updateEventStatus(input);
    },
    sendTyping: async () => {},
    sendThreadReply: async (input) => {
      calls.sendThreadReply(input);
    },
    sendUserMessage: async () => null,
    downloadAttachment: async (input) => input.attachment,
    formatOwnerNotification: async () => "owner notification",
  };
}

function makeResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "scheduled-session",
    exitCode: 0,
    success: true,
    parsed: { kind: "reply", text: "scheduled result" },
    logPath: "/tmp/scheduled.log",
    ...overrides,
  };
}

async function makeScheduledJob(
  cfg: Awaited<ReturnType<typeof makeTestConfig>>,
  overrides: Record<string, unknown> = {},
) {
  const job = SchedulerJobSchema.parse({
    id: "88888888-8888-4888-8888-888888888888",
    name: "engine-job",
    prompt: "Run this scheduled task.",
    origin: {
      source: "mattermost",
      thread_key: "mattermost:channel:root",
      source_thread_ref: {
        source: "mattermost",
        conversation_id: "channel",
        thread_id: "root",
        root_message_id: "root",
      },
      visibility: "channel",
    },
    schedule: { type: "interval", intervalMs: 1 },
    run_once: true,
    status: "active",
    output: "ringkas",
    retry: { max_attempts: 1, backoff_ms: 0 },
    permissions: ["scheduler:read"],
    created_by: { source: "mattermost", user_id: "user-1" },
    next_run_at: "2026-07-19T23:59:59.000Z",
    last_run_at: null,
    created_at: "2026-07-19T10:00:00.000Z",
    ...overrides,
  });
  const filePath = path.join(cfg.paths.schedulerJobsDir, `${job.id}.json`);
  await writeJsonAtomic(filePath, job);
  return { job, filePath };
}

afterEach(() => {
  stopScheduler();
  stopMemoryCron();
});

describe("scheduled engine execution", () => {
  it("uses the origin adapter, persists the turn, and delivers ringkas output", async () => {
    const cfg = await makeTestConfig("scheduler-engine-");
    await saveContact(cfg, {
      source: "mattermost",
      user_id: "user-1",
      allowed_permissions: ["scheduler:read"],
    });
    const calls = { sendThreadReply: vi.fn(), updateEventStatus: vi.fn() };
    const inputs: TurnInput[] = [];
    const harness: Harness = {
      run: async (input) => {
        inputs.push(input);
        return makeResult();
      },
    };
    const engine = new FelixEngine(cfg, [makeAdapter(calls)], harness);
    const { job, filePath } = await makeScheduledJob(cfg);

    await engine.boot();
    await tick();
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(filePath, "utf8")).status).toBe(
        "completed",
      );
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.event.source).toBe("mattermost");
    expect(inputs[0]?.event.thread_key).toBe(job.origin.thread_key);
    expect(calls.sendThreadReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("scheduled result"),
      }),
    );
    const session = JSON.parse(
      await fs.readFile(
        path.join(inputs[0]!.thread.dir, "session.json"),
        "utf8",
      ),
    ) as { harness_session_id?: string };
    expect(session.harness_session_id).toBe("scheduled-session");
  });

  it("does not deliver silent output and pauses when a grant is revoked", async () => {
    const cfg = await makeTestConfig("scheduler-silent-");
    await saveContact(cfg, {
      source: "mattermost",
      user_id: "user-1",
      allowed_permissions: [],
    });
    const calls = { sendThreadReply: vi.fn(), updateEventStatus: vi.fn() };
    const run = vi.fn(async () => makeResult());
    const engine = new FelixEngine(cfg, [makeAdapter(calls)], { run });
    const { filePath } = await makeScheduledJob(cfg, {
      output: "silent",
      permissions: ["scheduler:write"],
    });

    await engine.boot();
    await tick();
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(filePath, "utf8")).status).toBe(
        "paused",
      );
    });

    expect(run).not.toHaveBeenCalled();
    expect(calls.sendThreadReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("paused"),
      }),
    );
  });

  it("suppresses successful silent output", async () => {
    const cfg = await makeTestConfig("scheduler-silent-success-");
    await saveContact(cfg, {
      source: "mattermost",
      user_id: "user-1",
      allowed_permissions: ["scheduler:read"],
    });
    const calls = { sendThreadReply: vi.fn(), updateEventStatus: vi.fn() };
    const engine = new FelixEngine(cfg, [makeAdapter(calls)], {
      run: async () => makeResult(),
    });
    const { filePath } = await makeScheduledJob(cfg, { output: "silent" });

    await engine.boot();
    await tick();
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(filePath, "utf8")).status).toBe(
        "completed",
      );
    });

    expect(calls.sendThreadReply).not.toHaveBeenCalled();
  });

  it("pauses on a runtime permission request without creating approval state", async () => {
    const cfg = await makeTestConfig("scheduler-runtime-permission-");
    await saveContact(cfg, {
      source: "mattermost",
      user_id: "user-1",
      allowed_permissions: ["scheduler:read"],
    });
    const calls = { sendThreadReply: vi.fn(), updateEventStatus: vi.fn() };
    const inputs: TurnInput[] = [];
    const engine = new FelixEngine(cfg, [makeAdapter(calls)], {
      run: async (input) => {
        inputs.push(input);
        return makeResult({
          parsed: {
            kind: "permission_required",
            text: "Need permission to continue.",
            skillId: "scheduler",
            permissions: ["scheduler:write"],
          },
        });
      },
    });
    const { filePath } = await makeScheduledJob(cfg);

    await engine.boot();
    await tick();
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(filePath, "utf8")).status).toBe(
        "paused",
      );
    });

    expect(inputs).toHaveLength(1);
    expect(calls.sendThreadReply).toHaveBeenCalled();
    const session = JSON.parse(
      await fs.readFile(
        path.join(inputs[0]!.thread.dir, "session.json"),
        "utf8",
      ),
    ) as { pending_permission?: unknown };
    expect(session.pending_permission ?? null).toBeNull();
  });
});
