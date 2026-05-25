import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEventToThread, createOrLoadThread, hasThreadEvent, loadSessionState, queueThreadEvent } from "../src/thread-store.js";

describe("thread store", () => {
  it("deduplicates queued events by source event id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-thread-store-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const cfg = {
      WORKSPACE_DIR: workspace,
      paths: {
        root: workspace,
        raw: path.join(workspace, "raw"),
        threads: path.join(workspace, "threads"),
        contacts: path.join(workspace, "contacts"),
        skills: path.join(workspace, "skills"),
        logs: path.join(workspace, "logs"),
        media: path.join(workspace, "media"),
        codex: path.join(workspace, "codex"),
        health: path.join(workspace, ".health"),
      },
    } as never;
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:chan:root",
      source_thread: { channel_id: "chan", root_id: "root" },
      received_at: "2026-05-25T00:00:00.000Z",
    });

    await queueThreadEvent(thread, {
      received_at: "2026-05-25T00:00:00.000Z",
      event_file: path.join(thread.eventsDir, "2026-05-25T00-00-00Z_mattermost_evt.md"),
      source_event_id: "evt",
    });
    await queueThreadEvent(thread, {
      received_at: "2026-05-25T00:00:01.000Z",
      event_file: path.join(thread.eventsDir, "2026-05-25T00-00-01Z_mattermost_evt.md"),
      source_event_id: "evt",
    });

    const session = await loadSessionState(thread);
    expect(session.queue).toHaveLength(1);
    expect(session.queue[0]?.source_event_id).toBe("evt");
  });

  it("detects already recorded thread events by source and event id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-thread-event-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const cfg = {
      WORKSPACE_DIR: workspace,
      paths: {
        root: workspace,
        raw: path.join(workspace, "raw"),
        threads: path.join(workspace, "threads"),
        contacts: path.join(workspace, "contacts"),
        skills: path.join(workspace, "skills"),
        logs: path.join(workspace, "logs"),
        media: path.join(workspace, "media"),
        codex: path.join(workspace, "codex"),
        health: path.join(workspace, ".health"),
      },
    } as never;
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:chan:root",
      source_thread: { channel_id: "chan", root_id: "root" },
      received_at: "2026-05-25T00:00:00.000Z",
    });
    await appendEventToThread(thread, {
      source: "mattermost",
      event_id: "evt",
      thread_key: "mattermost:chan:root",
      received_at: "2026-05-25T00:00:00.000Z",
      visibility: "channel",
      mentions_bot: true,
      sender: { source: "mattermost", id: "user" },
      text: "hello",
      attachments: [],
      raw_path: "",
      source_thread: { channel_id: "chan", root_id: "root" },
    });

    await expect(hasThreadEvent(thread, "mattermost", "evt")).resolves.toBe(true);
    await expect(hasThreadEvent(thread, "mattermost", "other")).resolves.toBe(false);
  });
});
