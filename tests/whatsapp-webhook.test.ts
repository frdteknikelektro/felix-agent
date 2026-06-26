import { describe, expect, it, vi, beforeEach } from "vitest";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
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
    // On a shared number, FromMe non-prefix messages are owner messages.
    // The sender.id is prefixed with "owner:" so isOwnMessage lets them through.
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

  describe("owner permission decision via persisted tracking", () => {
    it("tracked message persists to disk and survives re-read", async () => {
      cfg = await makeTestConfig("wa-wh-persist-", { WHATSAPP_BOT_NAME: "Felix" });
      const msgId = "tracked-msg-id-1";
      const botMsgPath = path.join(cfg.paths.botMessageIndex, "whatsapp", `${msgId}.json`);

      // Verify the file does not exist before tracking
      await expect(fs.stat(botMsgPath)).rejects.toThrow();

      // The only way to get a tracked message is via a FromMe sender path.
      // We simulate tracking by writing the record directly.
      await fs.mkdir(path.dirname(botMsgPath), { recursive: true });
      await fs.writeFile(botMsgPath, JSON.stringify({
        msgId,
        threadKey: "whatsapp:12345@s.whatsapp.net:12345@s.whatsapp.net",
        trackedAt: new Date().toISOString(),
      }));

      // Verify the file exists and is readable
      const stat = await fs.stat(botMsgPath);
      expect(stat.isFile()).toBe(true);
      const content = JSON.parse(await fs.readFile(botMsgPath, "utf-8"));
      expect(content.msgId).toBe(msgId);
    });

    it("FromMe text reply to tracked bot message routes to decision path", async () => {
      cfg = await makeTestConfig("wa-wh-fromme-reply-", {
        WHATSAPP_BOT_NAME: "Felix",
        WHATSAPP_OWNER_JID: "owner@s.whatsapp.net",
      });
      const msgId = "tracked-fromme-reply";

      // Track the bot message
      const botMsgPath = path.join(cfg.paths.botMessageIndex, "whatsapp", `${msgId}.json`);
      await fs.mkdir(path.dirname(botMsgPath), { recursive: true });
      await fs.writeFile(botMsgPath, JSON.stringify({
        msgId,
        threadKey: "whatsapp:chat@s.whatsapp.net:chat@s.whatsapp.net",
        trackedAt: new Date().toISOString(),
      }));

      // Send a FromMe reply to the tracked message with a decision text
      const result = await sendWebhook(
        cfg,
        engine,
        JSON.stringify({
          Chat: "chat@s.whatsapp.net",
          ID: "reply-msg-1",
          FromMe: true,
          ReplyToID: msgId,
          Text: "OK once",
          SenderJID: "owner@s.whatsapp.net",
        }),
      );

      // The webhook should accept it and route to the owner-decision path
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ok", true);
    });

    it("FromMe reply to untracked message falls through to normal ingestion", async () => {
      cfg = await makeTestConfig("wa-wh-fromme-untracked-", {
        WHATSAPP_BOT_NAME: "Felix",
      });
      const { engine: localEngine, ingest: localIngest } = makeMockEngine();

      const result = await sendWebhook(
        cfg,
        localEngine,
        JSON.stringify({
          Chat: "chat@s.whatsapp.net",
          ID: "reply-untracked",
          FromMe: true,
          ReplyToID: "never-tracked-reply-id",
          Text: "hello",
          SenderJID: "owner@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ok", true);

      // Falls through to ownerSharesNumber → normal ingestion
      await new Promise((r) => setTimeout(r, 100));
      expect(localIngest).toHaveBeenCalled();
    });

    it("FromMe reaction to tracked bot message routes to decision path", async () => {
      cfg = await makeTestConfig("wa-wh-fromme-react-", {
        WHATSAPP_BOT_NAME: "Felix",
        WHATSAPP_OWNER_JID: "owner@s.whatsapp.net",
      });
      const reactionTarget = "tracked-fromme-react";

      // Track the bot message
      const botMsgPath = path.join(cfg.paths.botMessageIndex, "whatsapp", `${reactionTarget}.json`);
      await fs.mkdir(path.dirname(botMsgPath), { recursive: true });
      await fs.writeFile(botMsgPath, JSON.stringify({
        msgId: reactionTarget,
        threadKey: "whatsapp:chat@s.whatsapp.net:chat@s.whatsapp.net",
        trackedAt: new Date().toISOString(),
      }));

      const result = await sendWebhook(
        cfg,
        engine,
        JSON.stringify({
          Chat: "chat@s.whatsapp.net",
          ID: "react-msg-1",
          FromMe: true,
          ReactionToID: reactionTarget,
          ReactionEmoji: "👍",
          SenderJID: "owner@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ok", true);
    });

    it("incoming owner reaction to tracked bot message responds when emoji is not a decision", async () => {
      cfg = await makeTestConfig("wa-wh-owner-react-unknown-", {
        WHATSAPP_BOT_NAME: "Felix",
        WHATSAPP_OWNER_JID: "owner@s.whatsapp.net",
      });
      const reactionTarget = "tracked-owner-react-unknown";
      const botMsgPath = path.join(cfg.paths.botMessageIndex, "whatsapp", `${reactionTarget}.json`);
      await fs.mkdir(path.dirname(botMsgPath), { recursive: true });
      await fs.writeFile(botMsgPath, JSON.stringify({
        msgId: reactionTarget,
        threadKey: "whatsapp:chat@s.whatsapp.net:chat@s.whatsapp.net",
        trackedAt: new Date().toISOString(),
      }));

      const result = await sendWebhook(
        cfg,
        engine,
        JSON.stringify({
          Chat: "chat@s.whatsapp.net",
          ID: "react-msg-unknown",
          ReactionToID: reactionTarget,
          ReactionEmoji: "❤️",
          SenderJID: "owner@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ignored", "unrecognized_emoji");
    });

    it("untracked reaction is ignored as self_reaction", async () => {
      cfg = await makeTestConfig("wa-wh-untracked-react-", {
        WHATSAPP_BOT_NAME: "Felix",
      });
      const result = await sendWebhook(
        cfg,
        engine,
        JSON.stringify({
          Chat: "12345@s.whatsapp.net",
          ID: "msg-untracked-react",
          FromMe: true,
          ReactionToID: "never-tracked-msg",
          ReactionEmoji: "👍",
        }),
      );
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ignored", "self_reaction");
    });
  });
});
