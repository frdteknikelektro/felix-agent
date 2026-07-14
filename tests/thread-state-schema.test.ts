import { describe, expect, it } from "vitest";
import { readJsonParsed, writeJsonAtomic } from "../src/lib/fs.js";
import { ThreadStateSchema, type ThreadState } from "../src/core/schemas.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-schema-"));
  return path.join(dir, "thread.json");
}

function baseState(): ThreadState {
  return {
    thread_key: "mattermost:c:r",
    source: "mattermost",
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
    managed_by_felix: true,
    source_thread_ref: {
      source: "mattermost",
      conversation_id: "c",
      thread_id: "r",
      root_message_id: "r",
    },
    participants: [],
  };
}

describe("ThreadStateSchema persistence", () => {
  it("round-trips a blocked thread through writeJsonAtomic + readJsonParsed", async () => {
    const file = await tempFile();
    const state: ThreadState = { ...baseState(), blocked: true };
    await writeJsonAtomic(file, state);
    const reloaded = await readJsonParsed(file, ThreadStateSchema, null as unknown as ThreadState);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.blocked).toBe(true);
  });

  it("reads back blocked: undefined for an old record without the field", async () => {
    const file = await tempFile();
    const old: ThreadState = baseState();
    // No `blocked` key on the persisted JSON.
    await writeJsonAtomic(file, old);
    const reloaded = await readJsonParsed(file, ThreadStateSchema, null as unknown as ThreadState);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.blocked).toBeUndefined();
  });
});
