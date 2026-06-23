import { describe, expect, it, vi, beforeEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleWhatsAppWebhook } from "../src/adapters/whatsapp/index.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { FelixEngine } from "../src/engine.js";
import type { AppConfig } from "../src/config.js";

function makeMockEngine(): { engine: FelixEngine; ingest: ReturnType<typeof vi.fn>; handleOwnerDecision: ReturnType<typeof vi.fn> } {
  const ingest = vi.fn().mockResolvedValue(undefined);
  const handleOwnerDecision = vi.fn().mockResolvedValue(true);
  return {
    engine: { ingest, handleOwnerDecision } as unknown as FelixEngine,
    ingest,
    handleOwnerDecision,
  };
}

// Helper to send a fake webhook request and capture the response
async function sendWebhook(
  cfg: AppConfig,
  engine: FelixEngine,
  body: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleWhatsAppWebhook(cfg, engine as FelixEngine, req, res as never);
    });

    server.on("error", reject);

    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const http = require("node:http");
      const options = {
        hostname: "127.0.0.1",
        port,
        path: "/wa-webhook",
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...opts.headers,
        },
      };
      const req = http.request(options, (clientRes: any) => {
        let data = "";
        clientRes.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        clientRes.on("end", () => {
          setTimeout(() => {
            try {
              resolve({
                status: clientRes.statusCode || 200,
                body: data ? JSON.parse(data) : {},
              });
            } catch {
              resolve({ status: clientRes.statusCode || 200, body: {} });
            }
            server.close();
          }, 200);
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  });
}

describe("handleWhatsAppWebhook", () => {
  let engine: FelixEngine;
  let cfg: AppConfig;

  beforeEach(async () => {
    ({ engine } = makeMockEngine());
  });

  it("returns 400 for invalid JSON body", async () => {
    cfg = await makeTestConfig("wa-wh-json-", { WHATSAPP_BOT_NAME: "Felix" });
    const result = await sendWebhook(cfg, engine, "not json");
    expect(result.status).toBe(400);
    expect(result.body).toHaveProperty("error", "invalid_json");
  });

  it("ignores messages with missing Chat or ID", async () => {
    cfg = await makeTestConfig("wa-wh-miss-", { WHATSAPP_BOT_NAME: "Felix" });
    const result = await sendWebhook(cfg, engine, JSON.stringify({ Text: "hi" }));
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ignored", "missing_fields");
  });

  it("ignores broadcast chat messages", async () => {
    cfg = await makeTestConfig("wa-wh-bcast-", { WHATSAPP_BOT_NAME: "Felix" });
    const result = await sendWebhook(
      cfg,
      engine,
      JSON.stringify({ Chat: "status@broadcast", ID: "msg-1", Text: "status" }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ignored", "broadcast_chat");
  });

  it("drops FromMe messages starting with bot prefix", async () => {
    cfg = await makeTestConfig("wa-wh-prefix-", { WHATSAPP_BOT_NAME: "Felix" });
    const result = await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "msg-1",
        FromMe: true,
        Text: "*[Felix]* Hello",
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ignored", "self_message");
  });

  it("drops FromMe media-only messages as self_media when same number", async () => {
    cfg = await makeTestConfig("wa-wh-selfm-", { WHATSAPP_BOT_NAME: "Felix" });
    const result = await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "msg-2",
        FromMe: true,
        Media: { Type: "image", MimeType: "image/jpeg" },
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ignored", "self_media");
  });

  it("ignores FromMe reactions not on tracked bot messages", async () => {
    cfg = await makeTestConfig("wa-wh-selfr-", { WHATSAPP_BOT_NAME: "Felix" });
    const result = await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "msg-3",
        FromMe: true,
        ReactionToID: "unknown-msg",
        ReactionEmoji: "👍",
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ignored", "self_reaction");
  });

  it("accepts FromMe non-prefix messages as owner DM when same number", async () => {
    // When ownerSharesNumber is true (default module-level state), FromMe
    // messages that don't match the bot prefix are treated as owner DMs.
    cfg = await makeTestConfig("wa-wh-owndm-", {
      WHATSAPP_BOT_NAME: "Felix",
    });
    const result = await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "67890@s.whatsapp.net",
        ID: "msg-4",
        FromMe: true,
        Text: "something",
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ok", true);
  });

  it("drops empty events (no text, no media, no reaction)", async () => {
    cfg = await makeTestConfig("wa-wh-empty-", { WHATSAPP_BOT_NAME: "Felix" });
    const result = await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "msg-7",
        FromMe: false,
        SenderJID: "sender@s.whatsapp.net",
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ignored", "empty_event");
  });
});

// NOTE: Full integration tests for reply/reaction approval paths,
// media ingestion, and HMAC verification require deeper mocking of
// wacli spawnSync and botMessageIds tracking. Those are exercised
// indirectly via engine-routing.test.ts and the owner-decision test suite.
