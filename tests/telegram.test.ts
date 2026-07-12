import { describe, expect, it } from "vitest";
import { createTelegramAdapter } from "../src/adapters/telegram/index.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { SourceAdapter } from "../src/core/ports.js";

// ─── getTurnContext ────────────────────────────────────────────────────────

describe("TelegramAdapter getTurnContext", () => {
  it("returns Telegram-specific behavior instructions", async () => {
    const cfg = await makeTestConfig("tg-turnctx-", {});
    const adapter: SourceAdapter = createTelegramAdapter(cfg);

    const ctx = await adapter.getTurnContext({
      event: {
        source: "telegram",
        event_id: "evt-1",
        thread_key: "telegram:1706579477:1",
        received_at: "2026-07-01T00:00:00.000Z",
        visibility: "dm",
        mentions_bot: true,
        sender: { source: "telegram", id: "1706579477", display: "Farid" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: {
          source: "telegram",
          conversation_id: "1706579477",
          thread_id: "1706579477",
          root_message_id: "1706579477",
          message_id: "1",
          raw: { chat_id: "1706579477", chat_type: "private" },
        },
      },
    });

    expect(ctx.behaviorInstructions).toBeDefined();
    expect(ctx.behaviorInstructions.length).toBeGreaterThan(0);

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("Telegram");
    expect(joined).toContain("T1.");
    expect(joined).toContain("T2.");
    expect(joined).toContain("sendMessage");
    expect(joined).toContain("sendDocument");
    // T4 keeps replies short; T4b points the LLM at file attachments for
    // longer outputs (split into two instructions for readability).
    expect(joined).toContain("Keep Telegram replies concise");
    expect(joined).toContain("4096");
    expect(joined).toContain("T4b.");
    expect(joined).toContain("use `sendDocument` to upload it");
  });
});
