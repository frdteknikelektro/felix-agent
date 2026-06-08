import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FelixEngine } from "../src/engine.js";
import { createOrLoadThread, hasThreadEvent, loadSessionState } from "../src/slices/sessions/index.js";
import type { SourceAdapter } from "../src/core/ports.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

describe("FelixEngine Mattermost routing", () => {
  it("accepts unmentioned replies in threads already managed by Felix", async () => {
    const cfg = await makeTestConfig("felix-engine-routing-");

    const calls = {
      sendThreadReply: vi.fn(),
      sendUserMessage: vi.fn(),
      updateEventStatus: vi.fn(),
      downloadAttachment: vi.fn(),
    };

    const adapter: SourceAdapter = {
      source: "mattermost",
      getThreadLink: async () => undefined,
      getTurnContext: async () => ({ behaviorInstructions: [] }),
      updateEventStatus: async (input) => {
        calls.updateEventStatus(input);
      },
      sendThreadReply: async (input) => {
        calls.sendThreadReply(input);
      },
      sendUserMessage: async (input) => {
        calls.sendUserMessage(input);
        return null;
      },
      downloadAttachment: async (input) => {
        calls.downloadAttachment(input);
        return input.attachment;
      },
    };

    const engine = new FelixEngine(cfg, [adapter], new FakeHarness());
    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:channel:root",
      source_thread_ref: mattermostThreadRef("channel", "root"),
      received_at: "2026-05-25T00:00:00.000Z",
    });

    await engine.ingest({
      source: "mattermost",
      event_id: "evt-2",
      thread_key: "mattermost:channel:root",
      received_at: "2026-05-25T00:01:00.000Z",
      visibility: "channel",
      mentions_bot: false,
      sender: { source: "mattermost", id: "someone-else" },
      text: "replying in the same long thread",
      attachments: [],
      raw_path: path.join(cfg.paths.intake, "mattermost", "raw", "ignored", "evt-2.json"),
      source_thread_ref: mattermostThreadRef("channel", "root", "evt-2"),
    });

    // Unmentioned reply in a managed thread should be rejected (needs explicit @mention)
    expect(calls.updateEventStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing" }),
    );
    expect(await hasThreadEvent(thread, "mattermost", "evt-2")).toBe(false);
  });
});
