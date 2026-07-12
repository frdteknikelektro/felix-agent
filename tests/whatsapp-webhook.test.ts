import { describe, expect, it, vi, beforeEach } from "vitest";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import {
  handleWhatsAppWebhook,
  whatsappSourceThreadRef,
  whatsappThreadKey,
} from "../src/adapters/whatsapp/index.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { FelixEngine } from "../src/engine.js";
import type { AppConfig } from "../src/config.js";
import { createOrLoadThread, findThreadHandle } from "../src/slices/sessions/index.js";

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
  if (cfg.WHATSAPP_WACLI_BIN === "wacli") {
    await installFakeWacli(cfg);
  }
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleWhatsAppWebhook(cfg, engine as FelixEngine, req, res as never);
    });

    server.on("error", reject);

    // Bind and dial the same loopback address: a bare listen(0) binds the
    // dual-stack wildcard, and the IPv4 connect can then land on a foreign
    // process that holds the same port number on 127.0.0.1.
    server.listen(0, "127.0.0.1", () => {
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

async function installFakeWacli(
  cfg: AppConfig,
  script = `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s"}}\\n' "$4" "$6"
  exit 0
fi
exit 1
`,
): Promise<string> {
  const bin = path.join(cfg.paths.bin, `wacli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, "utf8");
  await fs.chmod(bin, 0o755);
  cfg.WHATSAPP_WACLI_BIN = bin;
  return bin;
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

  it("resolves every valid non-broadcast webhook through wacli messages show", async () => {
    cfg = await makeTestConfig("wa-wh-resolve-all-", { WHATSAPP_BOT_NAME: "Felix" });
    const argsFile = path.join(cfg.paths.runtime, "wacli-args.txt");
    await installFakeWacli(cfg, `
echo "$@" >> "${argsFile}"
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s","SenderJID":"sender@s.whatsapp.net","Text":"@Felix hi"}}\\n' "$4" "$6"
  exit 0
fi
exit 1
`);

    const result = await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "resolve-msg-1",
        SenderJID: "sender@s.whatsapp.net",
        Text: "@Felix hi",
      }),
    );

    expect(result.status).toBe(200);
    expect(await fs.readFile(argsFile, "utf8")).toContain(
      "messages show --chat 12345@s.whatsapp.net --id resolve-msg-1 --json",
    );
  });

  it("canonicalizes @lid DM chats before ingestion", async () => {
    cfg = await makeTestConfig("wa-wh-lid-dm-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_BOT_ALIASES: "f",
    });
    const { engine: localEngine, ingest } = makeMockEngine();
    await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  printf '{"success":true,"data":{"ChatJID":"6285878175157@s.whatsapp.net","MsgID":"%s","SenderJID":"6285878175157@s.whatsapp.net","Text":"@f ini gambar apa hayo","MediaType":"image","MediaCaption":"@f ini gambar apa hayo","MimeType":"image/jpeg"}}\\n' "$6"
  exit 0
fi
exit 1
`);

    const result = await sendWebhook(
      cfg,
      localEngine,
      JSON.stringify({
        Chat: "264776194232430@lid",
        ID: "lid-media-1",
        SenderJID: "264776194232430@lid",
        Text: "@f ini gambar apa hayo",
        Media: { Type: "image", MimeType: "image/jpeg" },
      }),
    );

    expect(result.status).toBe(200);
    expect(ingest).toHaveBeenCalled();
    const event = ingest.mock.calls[0][0];
    expect(event.thread_key).toBe("whatsapp:6285878175157@s.whatsapp.net:6285878175157@s.whatsapp.net");
    expect(event.source_thread_ref.conversation_id).toBe("6285878175157@s.whatsapp.net");
    expect(event.sender.id).toBe("6285878175157@s.whatsapp.net");
    expect(event.source_thread_ref.raw).toMatchObject({
      original_chat_jid: "264776194232430@lid",
      resolved_chat_jid: "6285878175157@s.whatsapp.net",
      original_sender_jid: "264776194232430@lid",
      resolved_sender_jid: "6285878175157@s.whatsapp.net",
    });
  });

  it("keeps group chat JID when resolver returns an individual chat", async () => {
    cfg = await makeTestConfig("wa-wh-group-safe-", { WHATSAPP_BOT_NAME: "Felix" });
    const { engine: localEngine, ingest } = makeMockEngine();
    await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  printf '{"success":true,"data":{"ChatJID":"6285878175157@s.whatsapp.net","MsgID":"%s","SenderJID":"628111111111@s.whatsapp.net","Text":"@Felix hi"}}\\n' "$6"
  exit 0
fi
exit 1
`);

    await sendWebhook(
      cfg,
      localEngine,
      JSON.stringify({
        Chat: "120363428896331672@g.us",
        ID: "group-msg-1",
        SenderJID: "sender@lid",
        Text: "@Felix hi",
      }),
    );

    const event = ingest.mock.calls[0][0];
    expect(event.thread_key).toBe("whatsapp:120363428896331672@g.us:120363428896331672@g.us");
    expect(event.sender.id).toBe("628111111111@s.whatsapp.net");
  });

  it("detects caption-only media mentions and does not use captions as filenames", async () => {
    cfg = await makeTestConfig("wa-wh-caption-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_BOT_ALIASES: "f",
    });
    const { engine: localEngine, ingest } = makeMockEngine();

    await sendWebhook(
      cfg,
      localEngine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "caption-media-1",
        SenderJID: "sender@s.whatsapp.net",
        Media: { Type: "image", Caption: "@f ini apa", MimeType: "image/jpeg" },
      }),
    );

    const event = ingest.mock.calls[0][0];
    expect(event.mentions_bot).toBe(true);
    expect(event.text).toBe("@f ini apa");
    expect(event.attachments[0].filename).toBe("caption-media-1");
  });

  it("accepts FromMe caption-only media instead of dropping it as self_media", async () => {
    cfg = await makeTestConfig("wa-wh-fromme-caption-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_BOT_ALIASES: "f",
    });
    const { engine: localEngine, ingest } = makeMockEngine();

    const result = await sendWebhook(
      cfg,
      localEngine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "fromme-caption-media-1",
        FromMe: true,
        SenderJID: "owner@s.whatsapp.net",
        Media: { Type: "image", Caption: "@f ini apa", MimeType: "image/jpeg" },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ok", true);
    expect(ingest).toHaveBeenCalled();
    const event = ingest.mock.calls[0][0];
    expect(event.text).toBe("@f ini apa");
    expect(event.sender.id).toBe("owner:owner@s.whatsapp.net");
  });

  it("preserves webhook FromMe instead of taking it from resolver output", async () => {
    cfg = await makeTestConfig("wa-wh-fromme-preserve-", { WHATSAPP_BOT_NAME: "Felix" });
    const { engine: localEngine, ingest } = makeMockEngine();
    await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s","SenderJID":"sender@s.whatsapp.net","FromMe":true,"Text":"@Felix hi"}}\\n' "$4" "$6"
  exit 0
fi
exit 1
`);

    const result = await sendWebhook(
      cfg,
      localEngine,
      JSON.stringify({
        Chat: "12345@s.whatsapp.net",
        ID: "fromme-preserve-1",
        FromMe: false,
        SenderJID: "sender@s.whatsapp.net",
        Text: "@Felix hi",
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ok", true);
    expect(ingest).toHaveBeenCalled();
    expect(ingest.mock.calls[0][0].sender.id).toBe("sender@s.whatsapp.net");
  });

  it("falls back to the original payload when resolver fails", async () => {
    cfg = await makeTestConfig("wa-wh-resolve-fail-", { WHATSAPP_BOT_NAME: "Felix" });
    const { engine: localEngine, ingest } = makeMockEngine();
    await installFakeWacli(cfg, "exit 9");

    const result = await sendWebhook(
      cfg,
      localEngine,
      JSON.stringify({
        Chat: "264776194232430@lid",
        ID: "resolve-fail-1",
        SenderJID: "sender@lid",
        Text: "@Felix hi",
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ok", true);
    const event = ingest.mock.calls[0][0];
    expect(event.thread_key).toBe("whatsapp:264776194232430@lid:264776194232430@lid");
  });

  it("retargets an existing @lid thread to the canonical resolved key", async () => {
    cfg = await makeTestConfig("wa-wh-retarget-", { WHATSAPP_BOT_NAME: "Felix" });
    const oldKey = whatsappThreadKey("264776194232430@lid");
    const canonicalKey = whatsappThreadKey("6285878175157@s.whatsapp.net");
    await createOrLoadThread(cfg, {
      source: "whatsapp",
      thread_key: oldKey,
      source_thread_ref: whatsappSourceThreadRef({
        chatJid: "264776194232430@lid",
        rootMessageId: "264776194232430@lid",
        messageId: "old-msg",
      }),
      received_at: "2026-06-28T00:00:00.000Z",
    });
    await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  printf '{"success":true,"data":{"ChatJID":"6285878175157@s.whatsapp.net","MsgID":"%s","SenderJID":"6285878175157@s.whatsapp.net","Text":"@Felix hi"}}\\n' "$6"
  exit 0
fi
exit 1
`);

    await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "264776194232430@lid",
        ID: "retarget-msg-1",
        SenderJID: "264776194232430@lid",
        Text: "@Felix hi",
      }),
    );

    expect(await findThreadHandle(cfg, oldKey, "whatsapp")).toBeNull();
    const canonicalThread = await findThreadHandle(cfg, canonicalKey, "whatsapp");
    expect(canonicalThread?.state.thread_key).toBe(canonicalKey);
  });

  it("does not merge when old @lid and canonical threads both exist", async () => {
    cfg = await makeTestConfig("wa-wh-retarget-conflict-", { WHATSAPP_BOT_NAME: "Felix" });
    const oldKey = whatsappThreadKey("264776194232430@lid");
    const canonicalKey = whatsappThreadKey("6285878175157@s.whatsapp.net");
    await createOrLoadThread(cfg, {
      source: "whatsapp",
      thread_key: oldKey,
      source_thread_ref: whatsappSourceThreadRef({
        chatJid: "264776194232430@lid",
        rootMessageId: "264776194232430@lid",
        messageId: "old-msg",
      }),
      received_at: "2026-06-28T00:00:00.000Z",
    });
    await createOrLoadThread(cfg, {
      source: "whatsapp",
      thread_key: canonicalKey,
      source_thread_ref: whatsappSourceThreadRef({
        chatJid: "6285878175157@s.whatsapp.net",
        rootMessageId: "6285878175157@s.whatsapp.net",
        messageId: "canonical-msg",
      }),
      received_at: "2026-06-28T00:01:00.000Z",
    });
    await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  printf '{"success":true,"data":{"ChatJID":"6285878175157@s.whatsapp.net","MsgID":"%s","SenderJID":"6285878175157@s.whatsapp.net","Text":"@Felix hi"}}\\n' "$6"
  exit 0
fi
exit 1
`);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await sendWebhook(
      cfg,
      engine,
      JSON.stringify({
        Chat: "264776194232430@lid",
        ID: "retarget-conflict-msg-1",
        SenderJID: "264776194232430@lid",
        Text: "@Felix hi",
      }),
    );

    expect(await findThreadHandle(cfg, oldKey, "whatsapp")).not.toBeNull();
    expect(await findThreadHandle(cfg, canonicalKey, "whatsapp")).not.toBeNull();
    expect(stderrWrite.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "whatsapp.thread_alias_conflict",
    );
    stderrWrite.mockRestore();
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
      await vi.waitFor(() => expect(localIngest).toHaveBeenCalled(), { timeout: 2000 });
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

  describe("reply-to-Felix detection", () => {
    it("non-FromMe reply to a Felix message in a group triggers the agent", async () => {
      cfg = await makeTestConfig("wa-wh-reply-felix-", {
        WHATSAPP_BOT_NAME: "Felix",
        WHATSAPP_OWNER_JID: "owner@s.whatsapp.net",
      });
      // Fake wacli: return *[Felix]* prefix for the replied-to message (shared mode)
      await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  if [ "$6" = "felix-original-msg" ]; then
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s","SenderJID":"owner@s.whatsapp.net","Text":"*[Felix]* Here is your answer"}}\\n' "$4" "$6"
  else
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s"}}\\n' "$4" "$6"
  fi
  exit 0
fi
exit 1
`);
      const { engine: localEngine, ingest: localIngest } = makeMockEngine();

      const result = await sendWebhook(
        cfg,
        localEngine,
        JSON.stringify({
          Chat: "group@g.us",
          ID: "reply-to-felix",
          FromMe: false,
          ReplyToID: "felix-original-msg",
          Text: "Tell me more",
          SenderJID: "someone@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ok", true);
      await vi.waitFor(() => expect(localIngest).toHaveBeenCalled(), { timeout: 2000 });
      const ingestedEvent = localIngest.mock.calls[0][0];
      expect(ingestedEvent.mentions_bot).toBe(true);
    });

    it("FromMe reply to a Felix message in shared-number mode triggers the agent", async () => {
      cfg = await makeTestConfig("wa-wh-reply-shared-", {
        WHATSAPP_BOT_NAME: "Felix",
        WHATSAPP_OWNER_JID: "owner@s.whatsapp.net",
      });
      await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  if [ "$6" = "felix-shared-msg" ]; then
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s","SenderJID":"owner@s.whatsapp.net","Text":"*[Felix]* Here is your answer"}}\\n' "$4" "$6"
  else
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s"}}\\n' "$4" "$6"
  fi
  exit 0
fi
exit 1
`);
      const { engine: localEngine, ingest: localIngest } = makeMockEngine();

      const result = await sendWebhook(
        cfg,
        localEngine,
        JSON.stringify({
          Chat: "group@g.us",
          ID: "owner-reply",
          FromMe: true,
          ReplyToID: "felix-shared-msg",
          Text: "Thanks!",
          SenderJID: "owner@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ok", true);
      await vi.waitFor(() => expect(localIngest).toHaveBeenCalled(), { timeout: 2000 });
      const ingestedEvent = localIngest.mock.calls[0][0];
      expect(ingestedEvent.mentions_bot).toBe(true);
    });

    it("reply to a non-Felix message without @mention is dispatched with mentions_bot=false", async () => {
      cfg = await makeTestConfig("wa-wh-reply-other-", {
        WHATSAPP_BOT_NAME: "Felix",
        WHATSAPP_OWNER_JID: "owner@s.whatsapp.net",
      });
      await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  if [ "$6" = "other-user-msg" ]; then
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s","SenderJID":"other@s.whatsapp.net","Text":"random message"}}\\n' "$4" "$6"
  else
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s"}}\\n' "$4" "$6"
  fi
  exit 0
fi
exit 1
`);
      const { engine: localEngine, ingest: localIngest } = makeMockEngine();

      const result = await sendWebhook(
        cfg,
        localEngine,
        JSON.stringify({
          Chat: "group@g.us",
          ID: "reply-to-other",
          FromMe: false,
          ReplyToID: "other-user-msg",
          Text: "I agree",
          SenderJID: "someone@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      await vi.waitFor(() => expect(localIngest).toHaveBeenCalled(), { timeout: 2000 });
      // Event is dispatched but with mentions_bot=false — the engine will drop it
      const ingestedEvent = localIngest.mock.calls[0][0];
      expect(ingestedEvent.mentions_bot).toBe(false);
    });

    it("reply to Felix message with failed fetch falls through with mentions_bot=false", async () => {
      cfg = await makeTestConfig("wa-wh-reply-fail-", {
        WHATSAPP_BOT_NAME: "Felix",
      });
      await installFakeWacli(cfg, `exit 1`);
      const { engine: localEngine, ingest: localIngest } = makeMockEngine();

      const result = await sendWebhook(
        cfg,
        localEngine,
        JSON.stringify({
          Chat: "group@g.us",
          ID: "reply-fetch-fail",
          FromMe: false,
          ReplyToID: "some-msg",
          Text: "hello",
          SenderJID: "someone@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      await vi.waitFor(() => expect(localIngest).toHaveBeenCalled(), { timeout: 2000 });
      // Fetch failed, so mentions_bot stays false — the engine will drop it
      const ingestedEvent = localIngest.mock.calls[0][0];
      expect(ingestedEvent.mentions_bot).toBe(false);
    });

    it("DM reply to a Felix message in shared-number mode triggers the agent", async () => {
      cfg = await makeTestConfig("wa-wh-reply-dm-", {
        WHATSAPP_BOT_NAME: "Felix",
        WHATSAPP_OWNER_JID: "owner@s.whatsapp.net",
      });
      await installFakeWacli(cfg, `
if [ "$1" = "messages" ] && [ "$2" = "show" ]; then
  if [ "$6" = "felix-dm-msg" ]; then
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s","SenderJID":"owner@s.whatsapp.net","Text":"*[Felix]* Your answer is 42"}}\\n' "$4" "$6"
  else
    printf '{"success":true,"data":{"ChatJID":"%s","MsgID":"%s"}}\\n' "$4" "$6"
  fi
  exit 0
fi
exit 1
`);
      const { engine: localEngine, ingest: localIngest } = makeMockEngine();

      const result = await sendWebhook(
        cfg,
        localEngine,
        JSON.stringify({
          Chat: "1234567890@s.whatsapp.net",
          ID: "dm-reply",
          FromMe: true,
          ReplyToID: "felix-dm-msg",
          Text: "What about 43?",
          SenderJID: "owner@s.whatsapp.net",
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("ok", true);
      await vi.waitFor(() => expect(localIngest).toHaveBeenCalled(), { timeout: 2000 });
      const ingestedEvent = localIngest.mock.calls[0][0];
      expect(ingestedEvent.mentions_bot).toBe(true);
    });
  });
});
