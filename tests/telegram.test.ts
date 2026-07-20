import { describe, expect, it } from "vitest";
import {
  createTelegramAdapter,
  handleTelegramWebhook,
  startTelegramSource,
} from "../src/adapters/telegram/index.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { SourceAdapter } from "../src/core/ports.js";
import { Readable } from "node:stream";
import { afterEach, vi } from "vitest";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── getTurnContext ────────────────────────────────────────────────────────

describe("TelegramAdapter getTurnContext", () => {
  it("uses the configured agent name when no Telegram username is known", async () => {
    const cfg = await makeTestConfig("tg-turnctx-name-", {
      FELIX_NAME: "Nova",
    });
    const adapter: SourceAdapter = createTelegramAdapter(cfg);

    const ctx = await adapter.getTurnContext({
      event: {
        source: "telegram",
        event_id: "evt-name",
        thread_key: "telegram:1706579477:1",
        received_at: "2026-07-01T00:00:00.000Z",
        visibility: "channel",
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
          raw: { chat_id: "1706579477", chat_type: "group" },
        },
      },
    });

    expect(ctx.behaviorInstructions[0]).toContain("@Nova");
  });

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

describe("TelegramAdapter scheduled replies", () => {
  it("does not reply to a synthetic scheduler message", async () => {
    const cfg = await makeTestConfig("tg-scheduled-reply-", {
      TELEGRAM_BOT_TOKEN: "token",
    });
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 2 } }),
      );
    }) as typeof fetch;

    try {
      const adapter = createTelegramAdapter(cfg);
      await adapter.sendThreadReply({
        event: {
          source: "telegram",
          event_id: "scheduler-job-execution",
          synthetic: "scheduled",
          thread_key: "telegram:1706579477:1",
          received_at: "2026-07-01T00:00:00.000Z",
          visibility: "channel",
          mentions_bot: false,
          sender: { source: "telegram", id: "1706579477" },
          text: "scheduled prompt",
          attachments: [],
          raw_path: "",
          source_thread_ref: {
            source: "telegram",
            conversation_id: "1706579477",
            thread_id: "1706579477",
            root_message_id: "1706579477",
          },
        },
        text: "scheduled response",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.reply_parameters).toBeUndefined();
  });
});

describe("Telegram transport modes", () => {
  it("does not start from the legacy identity when getMe is unavailable", async () => {
    const cfg = await makeTestConfig("tg-api-required-", {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_BOT_USER_ID: "legacy-id",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "unavailable" }), {
        status: 503,
      })) as typeof fetch;
    try {
      const handle = await startTelegramSource(cfg, {} as never);
      await handle.done;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses getMe for API-derived identity and registers/cleans up webhook mode", async () => {
    const cfg = await makeTestConfig("tg-webhook-lifecycle-", {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "https://example.com/webhooks/telegram",
      TELEGRAM_WEBHOOK_SECRET: "secret",
    });
    const calls: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = url.split("/").pop() ?? "";
      calls.push(method);
      if (method === "getMe")
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 42,
              is_bot: true,
              first_name: "NovaBot",
              username: "nova_bot",
            },
          }),
        );
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as typeof fetch;
    const handle = await startTelegramSource(cfg, {} as never);
    expect(handle).toBeDefined();
    expect(calls).toEqual(["getMe", "setWebhook"]);
    handle.stop();
    await handle.done;
    expect(calls).toEqual(["getMe", "setWebhook", "deleteWebhook"]);
  });

  it("rejects webhook requests without the configured secret", async () => {
    const cfg = await makeTestConfig("tg-webhook-secret-", {
      TELEGRAM_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "https://example.com/webhooks/telegram",
      TELEGRAM_WEBHOOK_SECRET: "secret",
    });
    const req = Object.assign(Readable.from(["{}"]), { headers: {} });
    const response = {
      statusCode: 0,
      headers: new Map<string, string>(),
      setHeader(k: string, v: string) {
        this.headers.set(k, v);
      },
      end: vi.fn(),
    };
    await handleTelegramWebhook(
      cfg,
      {} as never,
      req as never,
      response as never,
    );
    expect(response.statusCode).toBe(401);
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({ error: "invalid_secret" }),
    );
  });

  it("returns a retryable response when webhook identity cannot be discovered", async () => {
    const cfg = await makeTestConfig("tg-webhook-identity-failure-", {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "https://example.com/webhooks/telegram",
      TELEGRAM_WEBHOOK_SECRET: "secret",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "unavailable" }), {
        status: 503,
      })) as typeof fetch;
    const req = Object.assign(Readable.from(["{}"]), {
      headers: { "x-telegram-bot-api-secret-token": "secret" },
    });
    const response = {
      statusCode: 0,
      headers: new Map<string, string>(),
      setHeader(k: string, v: string) {
        this.headers.set(k, v);
      },
      end: vi.fn(),
    };
    try {
      await handleTelegramWebhook(
        cfg,
        {} as never,
        req as never,
        response as never,
      );
      expect(response.statusCode).toBe(503);
      expect(response.end).toHaveBeenCalledWith(
        JSON.stringify({ error: "telegram_identity_unavailable" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
