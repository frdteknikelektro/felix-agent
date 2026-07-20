import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionDetail } from "../src/owner-data.js";
import { createOrLoadThread } from "../src/slices/sessions/index.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

describe("owner session artifacts", () => {
  it("keeps the CLI progress artifact out of Owner raw artifacts", async () => {
    const cfg = await makeTestConfig("felix-owner-artifacts-");
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:channel:artifact-filter",
      source_thread_ref: mattermostThreadRef("channel", "artifact-filter"),
      received_at: "2026-07-20T12:00:00.000Z",
    });
    await fs.writeFile(path.join(thread.turnsDir, "progress.ndjson"), '{"phase":"thinking"}\n');
    await fs.writeFile(path.join(thread.turnsDir, "turn.log"), "raw harness output\n");

    const detail = await loadSessionDetail(cfg, thread.state.thread_key);
    const artifactPaths = detail?.artifacts.map((artifact) => artifact.path) ?? [];

    expect(artifactPaths).not.toContain("turns/progress.ndjson");
    expect(artifactPaths).toContain("turns/turn.log");
  });
});
