import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWhatsAppAdapter,
  whatsappThreadKey,
  whatsappSourceThreadRef,
  detectsWhatsappMention,
  isWhatsAppGroupJid,
  isFelixMessage,
} from "../src/adapters/whatsapp/index.js";
import type { ReplyTargetInfo } from "../src/adapters/whatsapp/index.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { SourceAdapter } from "../src/core/ports.js";

// ─── Thread key ────────────────────────────────────────────────────────────

describe("whatsappThreadKey", () => {
  it("formats as whatsapp:<jid>:<jid>", () => {
    expect(whatsappThreadKey("1234567890@s.whatsapp.net"))
      .toBe("whatsapp:1234567890@s.whatsapp.net:1234567890@s.whatsapp.net");
  });

  it("works for group JIDs", () => {
    expect(whatsappThreadKey("123456789@g.us"))
      .toBe("whatsapp:123456789@g.us:123456789@g.us");
  });
});

// ─── SourceThreadRef ───────────────────────────────────────────────────────

describe("whatsappSourceThreadRef", () => {
  it("builds correct ref with all fields", () => {
    const ref = whatsappSourceThreadRef({
      chatJid: "1234567890@s.whatsapp.net",
      rootMessageId: "1234567890@s.whatsapp.net",
      messageId: "msg-id-abc",
      senderJid: "15551234567@s.whatsapp.net",
    });
    expect(ref.source).toBe("whatsapp");
    expect(ref.conversation_id).toBe("1234567890@s.whatsapp.net");
    expect(ref.thread_id).toBe("1234567890@s.whatsapp.net");
    expect(ref.root_message_id).toBe("1234567890@s.whatsapp.net");
    expect(ref.message_id).toBe("msg-id-abc");
    expect(ref.raw).toEqual({
      chat_jid: "1234567890@s.whatsapp.net",
      sender_jid: "15551234567@s.whatsapp.net",
    });
  });

  it("handles missing optional fields", () => {
    const ref = whatsappSourceThreadRef({
      chatJid: "1234567890@s.whatsapp.net",
      rootMessageId: "1234567890@s.whatsapp.net",
      messageId: "msg-id-abc",
    });
    expect(ref.raw?.sender_jid).toBeUndefined();
  });
});

// ─── getTurnContext ────────────────────────────────────────────────────────

describe("WhatsAppAdapter getTurnContext", () => {
  it("returns WhatsApp-specific behavior instructions", async () => {
    const cfg = await makeTestConfig("wa-turnctx-", {
      WHATSAPP_BOT_NAME: "Felix",
    });
    const adapter: SourceAdapter = createWhatsAppAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "whatsapp",
        event_id: "evt-1",
        thread_key: "whatsapp:1234567890@s.whatsapp.net:1234567890@s.whatsapp.net",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "dm",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "15551234567@s.whatsapp.net" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "1234567890@s.whatsapp.net",
          rootMessageId: "1234567890@s.whatsapp.net",
          messageId: "msg-3",
        }),
      },
    });

    expect(ctx.behaviorInstructions).toBeDefined();
    expect(ctx.behaviorInstructions.length).toBeGreaterThan(0);

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("WhatsApp");
    expect(joined).toContain("wacli messages list");
    expect(joined).toContain("https://wacli.sh/");
    expect(joined).toContain("wacli send file");
    expect(joined).toContain("Do NOT call `wacli send text` for your final reply");
    expect(joined).toContain("never guess or synthesize the mention target");
    expect(joined).toContain("exact `.sender_jid`");
    // Audio instructions live in skills/listen-speak/SKILL.md (covered by listen-speak-skill.test.ts); src/AGENTS.md points there.
    // Default (no shared number): no name prefix is baked into the caption
    // template because the dedicated number already identifies the bot.
    expect(joined).not.toContain("[Felix]");
    // W6 tells the LLM to keep replies short and to fall back to file
    // attachments for longer outputs. The hard-limit mention should refer
    // to WhatsApp's own limit, not Telegram's.
    expect(joined).toContain("Keep WhatsApp replies concise");
    expect(joined).toContain("WhatsApp's hard text limit is 65,536");
    expect(joined).not.toContain("Telegram's hard text limit");
    expect(joined).toContain("use `wacli send file` to send it as an attachment");
  });

  it("bakes the bot name prefix into the caption template when the bot shares the owner's number", async () => {
    const cfg = await makeTestConfig("wa-turnctx-shared-", {
      WHATSAPP_BOT_NAME: "Felix",
    });
    const adapter = createWhatsAppAdapter(cfg);
    // Simulate the shared-number detection that start() performs from wacli auth.
    (adapter as unknown as { sameNumber: boolean }).sameNumber = true;

    const ctx = await adapter.getTurnContext({
      event: {
        source: "whatsapp",
        event_id: "evt-1",
        thread_key: "whatsapp:1234567890@s.whatsapp.net:1234567890@s.whatsapp.net",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "dm",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "15551234567@s.whatsapp.net" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "1234567890@s.whatsapp.net",
          rootMessageId: "1234567890@s.whatsapp.net",
          messageId: "msg-3",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    // The LLM is no longer told to add the prefix manually — the adapter's
    // static send paths (sendThreadReply / sendUserMessage) own it. Replies
    // look like any other channel's, regardless of sameNumber mode.
    expect(joined).not.toContain("MUST start with the *[Felix]*");
    expect(joined).not.toContain("do NOT add a name prefix");
    expect(joined).not.toContain("Always include the *[Felix]* prefix in file captions");
    // The `wacli send text` double-send guard is preserved (renumbered to W4
    // now that the W4 prefix instruction is gone).
    expect(joined).toContain("Do NOT call `wacli send text` for your final reply");
    // Caption template bakes the prefix in for file uploads so `wacli send
    // file` carries it even though the LLM no longer types it.
    expect(joined).toContain(`*[Felix]*\n<optional caption>`);
  });

  it("instructs mentioning the owner via wacli --mention when an owner jid is configured", async () => {
    const cfg = await makeTestConfig("wa-turnctx-owner-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_OWNER_JID: "9876543210@s.whatsapp.net",
    });
    const adapter = createWhatsAppAdapter(cfg);

    const ctx = await adapter.getTurnContext({
      event: {
        source: "whatsapp",
        event_id: "evt-1",
        thread_key: "whatsapp:123456789@g.us:123456789@g.us",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "15551234567@s.whatsapp.net" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "123456789@g.us",
          rootMessageId: "123456789@g.us",
          messageId: "msg-3",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("PERMISSION_REQUIRED");
    expect(joined).toContain("--mention \"9876543210@s.whatsapp.net\"");
    expect(joined).toContain("--to \"123456789@g.us\"");
  });

  it("does not instruct an owner mention when no owner jid is configured", async () => {
    const cfg = await makeTestConfig("wa-turnctx-no-owner-", {
      WHATSAPP_BOT_NAME: "Felix",
    });
    const adapter = createWhatsAppAdapter(cfg);

    const ctx = await adapter.getTurnContext({
      event: {
        source: "whatsapp",
        event_id: "evt-1",
        thread_key: "whatsapp:123456789@g.us:123456789@g.us",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "15551234567@s.whatsapp.net" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "123456789@g.us",
          rootMessageId: "123456789@g.us",
          messageId: "msg-3",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).not.toContain("PERMISSION_REQUIRED");
  });

  it("does not instruct an owner mention when the bot shares the owner's number", async () => {
    const cfg = await makeTestConfig("wa-turnctx-owner-same-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_OWNER_JID: "9876543210@s.whatsapp.net",
    });
    const adapter = createWhatsAppAdapter(cfg);
    (adapter as unknown as { sameNumber: boolean }).sameNumber = true;

    const ctx = await adapter.getTurnContext({
      event: {
        source: "whatsapp",
        event_id: "evt-1",
        thread_key: "whatsapp:123456789@g.us:123456789@g.us",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "15551234567@s.whatsapp.net" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "123456789@g.us",
          rootMessageId: "123456789@g.us",
          messageId: "msg-3",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).not.toContain("PERMISSION_REQUIRED");
  });
});

// ─── Mention detection ─────────────────────────────────────────────────────

describe("detectsWhatsappMention", () => {
  it("detects @botname mention", () => {
    expect(detectsWhatsappMention("@FelixBot hello", "FelixBot")).toBe(true);
    expect(detectsWhatsappMention("hey @FelixBot what's up?", "FelixBot")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectsWhatsappMention("@felixbot hi", "FelixBot")).toBe(true);
  });

  it("returns false when bot name is not mentioned", () => {
    expect(detectsWhatsappMention("hello world", "FelixBot")).toBe(false);
    expect(detectsWhatsappMention("@OtherBot hi", "FelixBot")).toBe(false);
  });

  it("does not match partial name", () => {
    expect(detectsWhatsappMention("@Felix hi", "FelixBot")).toBe(false);
  });
});

describe("isWhatsAppGroupJid", () => {
  it("detects group JIDs even when wacli decorates the identifier", () => {
    expect(isWhatsAppGroupJid("123456789@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("123456789@g.us:extra")).toBe(true);
    expect(isWhatsAppGroupJid("1234567890@s.whatsapp.net")).toBe(false);
  });
});

// ─── isFelixMessage ─────────────────────────────────────────────────────────

describe("isFelixMessage", () => {
  const botName = "Felix";

  it("matches by *[BotName]* prefix in text (shared mode)", () => {
    const target: ReplyTargetInfo = {
      senderJid: "owner@s.whatsapp.net",
      text: "*[Felix]* Here is your answer",
      mediaCaption: "",
    };
    expect(isFelixMessage(target, botName)).toBe(true);
  });

  it("matches by *[BotName]* prefix in media caption (shared mode)", () => {
    const target: ReplyTargetInfo = {
      senderJid: "owner@s.whatsapp.net",
      text: "",
      mediaCaption: "*[Felix]* Check this file",
    };
    expect(isFelixMessage(target, botName)).toBe(true);
  });

  it("does not match when text has no prefix", () => {
    const target: ReplyTargetInfo = {
      senderJid: "owner@s.whatsapp.net",
      text: "Hello from the owner",
      mediaCaption: "",
    };
    expect(isFelixMessage(target, botName)).toBe(false);
  });

  it("does not match when sender is a random user", () => {
    const target: ReplyTargetInfo = {
      senderJid: "someone@s.whatsapp.net",
      text: "random message",
      mediaCaption: "",
    };
    expect(isFelixMessage(target, botName)).toBe(false);
  });

  it("does not match empty text and caption", () => {
    const target: ReplyTargetInfo = {
      senderJid: "owner@s.whatsapp.net",
      text: "",
      mediaCaption: "",
    };
    expect(isFelixMessage(target, botName)).toBe(false);
  });

  it("dedicated mode: matches when senderJid matches botJid (set via module scope)", async () => {
    // In production, botJid is set during adapter.start(). In tests it's undefined,
    // so the senderJid check is skipped. This test documents that the prefix-based
    // shared mode check still works as the fallback.
    const target: ReplyTargetInfo = {
      senderJid: "bot@s.whatsapp.net",
      text: "Hello from bot",
      mediaCaption: "",
    };
    // Without botJid set, only prefix check runs — no prefix means no match
    expect(isFelixMessage(target, botName)).toBe(false);
    // With prefix, it matches regardless of senderJid
    const felixTarget: ReplyTargetInfo = {
      senderJid: "bot@s.whatsapp.net",
      text: "*[Felix]* Hello from bot",
      mediaCaption: "",
    };
    expect(isFelixMessage(felixTarget, botName)).toBe(true);
  });
});

describe("WhatsApp mention detection (via getTurnContext)", () => {
  it("documents @mention behavior in group instructions", async () => {
    const cfg = await makeTestConfig("wa-mention-", {
      WHATSAPP_BOT_NAME: "FelixBot",
    });
    const adapter = createWhatsAppAdapter(cfg);

    const ctx = await adapter.getTurnContext({
      event: {
        source: "whatsapp",
        event_id: "evt-1",
        thread_key: "whatsapp:123456789@g.us:123456789@g.us",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "sender-1" },
        text: "hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "123456789@g.us",
          rootMessageId: "123456789@g.us",
          messageId: "msg-3",
        }),
      },
    });

    const joined = ctx.behaviorInstructions.join("\n");
    expect(joined).toContain("@mentioned by name");
    expect(joined).toContain("@mentioned");
  });
});

// ─── Adapter identity ──────────────────────────────────────────────────────

describe("WhatsAppAdapter source property", () => {
  it("identifies as whatsapp", async () => {
    const cfg = await makeTestConfig("wa-src-");
    const adapter = createWhatsAppAdapter(cfg);
    expect(adapter.source).toBe("whatsapp");
  });

  it("has undefined botUserId (shared-number model)", async () => {
    const cfg = await makeTestConfig("wa-src2-");
    const adapter = createWhatsAppAdapter(cfg);
    expect(adapter.botUserId).toBeUndefined();
  });

  it("returns ownerUserId from config", async () => {
    const cfg = await makeTestConfig("wa-src3-", {
      WHATSAPP_OWNER_JID: "9876543210@s.whatsapp.net",
    });
    const adapter = createWhatsAppAdapter(cfg);
    expect(adapter.ownerUserId).toBe("9876543210@s.whatsapp.net");
  });
});

// ─── getThreadLink ─────────────────────────────────────────────────────────

describe("WhatsAppAdapter getThreadLink", () => {
  it("returns undefined (no shareable URLs)", async () => {
    const cfg = await makeTestConfig("wa-link-");
    const adapter = createWhatsAppAdapter(cfg);
    const link = await adapter.getThreadLink("whatsapp:a:a");
    expect(link).toBeUndefined();
  });
});

// ─── Format notification ───────────────────────────────────────────────────

describe("WhatsAppAdapter formatOwnerNotification", () => {
  it("includes reply instructions for pending requests", async () => {
    const cfg = await makeTestConfig("wa-notif-");
    const adapter = createWhatsAppAdapter(cfg);
    const msg = await adapter.formatOwnerNotification({
      skillId: "test-skill",
      permissions: ["read"],
      reason: "need access",
      requesterName: "Alice",
      requesterId: "alice@s.whatsapp.net",
      status: "pending",
    });

    expect(msg).toContain("*Requester*\nAlice");
    expect(msg).toContain("`test-skill`");
    expect(msg).toContain("`yes`");
    expect(msg).toContain("`always`");
    expect(msg).toContain("`no`");
  });

  it("handles resolved requests", async () => {
    const cfg = await makeTestConfig("wa-notif2-");
    const adapter = createWhatsAppAdapter(cfg);
    const msg = await adapter.formatOwnerNotification({
      skillId: "test-skill",
      permissions: ["read"],
      reason: "need access",
      requesterName: "Alice",
      requesterId: "alice@s.whatsapp.net",
      status: "approved",
      decisionMode: "always",
      decidedAt: "2026-06-01T00:00:00Z",
    });

    expect(msg).toContain("*Status*\n`approved`");
    expect(msg).toContain("*Decision*\n");
  });
});

// ─── downloadAttachment argument construction ───────────────────────────────

describe("WhatsAppAdapter downloadAttachment argument shape", () => {
  it("passes correct wacli media download args", async () => {
    const cfg = await makeTestConfig("wa-dl-");
    const adapter = createWhatsAppAdapter(cfg);

    // downloadAttachment requires spawnSync which is real; this test
    // validates that the method exists and accepts the expected interface
    expect(adapter.downloadAttachment).toBeDefined();
    expect(typeof adapter.downloadAttachment).toBe("function");

    // Verify that the method throws appropriately when conversation_id is missing
    await expect(
      adapter.downloadAttachment({
        event: {
          source: "whatsapp",
          event_id: "msg-1",
          thread_key: "whatsapp:a:a",
          received_at: "2026-01-01T00:00:00.000Z",
          visibility: "channel",
          mentions_bot: true,
          sender: { source: "whatsapp", id: "sender", display: "S" },
          text: "",
          attachments: [],
          raw_path: "",
          source_thread_ref: whatsappSourceThreadRef({
            chatJid: "", // missing
            rootMessageId: "a",
            messageId: "msg-1",
          }),
        },
        attachment: {
          file_id: "file-1",
          filename: "test.png",
          content_type: "image/png",
        },
        destinationDir: "/tmp",
        maxBytes: 10_000_000,
      }),
    ).rejects.toThrow("missing conversation_id");
  });

  it("copies the synced store file and skips a second media download", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-dl-copy-"));
    const logFile = path.join(root, "log.txt");
    const storeFile = path.join(root, "store-media.png");
    await fs.writeFile(storeFile, "real-image-bytes");
    const destDir = path.join(root, "attachments");
    await fs.mkdir(destDir, { recursive: true });
    const bin = path.join(root, "wacli");
    // messages show is LID-tolerant and returns the canonical ChatJID + the
    // LocalPath that `sync --download-media` recorded.
    await fs.writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, args.join(" ") + "\\n");
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === "messages" && args[1] === "show") {
  process.stdout.write(JSON.stringify({ success: true, data: { MsgID: get("--id"), ChatJID: "447356168511@s.whatsapp.net", LocalPath: ${JSON.stringify(storeFile)} } }));
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 },
    );

    const cfg = await makeTestConfig("wa-dl-copy-cfg-", { WHATSAPP_WACLI_BIN: bin });
    const adapter = createWhatsAppAdapter(cfg);

    const result = await adapter.downloadAttachment({
      event: {
        source: "whatsapp",
        event_id: "msg-1",
        thread_key: "whatsapp:a:a",
        received_at: "2026-01-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "sender", display: "S" },
        text: "",
        attachments: [],
        raw_path: "",
        // webhook may hand us the raw @lid form
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "152527844733129@lid",
          rootMessageId: "a",
          messageId: "msg-1",
        }),
      },
      attachment: { file_id: "wamid-1", filename: "photo.png", content_type: "image/png" },
      destinationDir: destDir,
      maxBytes: 10_000_000,
    });

    expect(result.status).toBe("available");
    expect(await fs.readFile(result.local_path!, "utf8")).toBe("real-image-bytes");
    const log = await fs.readFile(logFile, "utf8");
    expect(log).toContain("messages show");
    expect(log).not.toContain("media download");
  });

  it("falls back to media download against the canonical JID when no synced file exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-dl-fallback-"));
    const logFile = path.join(root, "log.txt");
    const destDir = path.join(root, "attachments");
    await fs.mkdir(destDir, { recursive: true });
    const bin = path.join(root, "wacli");
    // messages show resolves @lid → canonical PN but reports no LocalPath yet.
    await fs.writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, args.join(" ") + "\\n");
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === "messages" && args[1] === "show") {
  process.stdout.write(JSON.stringify({ success: true, data: { MsgID: get("--id"), ChatJID: "447356168511@s.whatsapp.net", LocalPath: "" } }));
  process.exit(0);
}
if (args[0] === "media" && args[1] === "download") {
  fs.writeFileSync(get("--output"), "fetched-bytes");
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 },
    );

    const cfg = await makeTestConfig("wa-dl-fallback-cfg-", { WHATSAPP_WACLI_BIN: bin });
    const adapter = createWhatsAppAdapter(cfg);

    const result = await adapter.downloadAttachment({
      event: {
        source: "whatsapp",
        event_id: "msg-1",
        thread_key: "whatsapp:a:a",
        received_at: "2026-01-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "sender", display: "S" },
        text: "",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "152527844733129@lid",
          rootMessageId: "a",
          messageId: "msg-1",
        }),
      },
      attachment: { file_id: "wamid-1", filename: "photo.png", content_type: "image/png" },
      destinationDir: destDir,
      maxBytes: 10_000_000,
    });

    expect(result.status).toBe("available");
    expect(await fs.readFile(result.local_path!, "utf8")).toBe("fetched-bytes");
    const log = (await fs.readFile(logFile, "utf8")).trim().split("\n");
    const dlLine = log.find((l) => l.startsWith("media download"));
    expect(dlLine).toBeDefined();
    // download must use the canonical PN JID, not the raw @lid from the webhook
    expect(dlLine).toContain("--chat 447356168511@s.whatsapp.net");
    expect(dlLine).not.toContain("@lid");
  });

  it("rejects a synced file that exceeds maxBytes despite a small declared size", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-dl-oversize-"));
    const storeFile = path.join(root, "store-media.bin");
    await fs.writeFile(storeFile, "x".repeat(5000));
    const destDir = path.join(root, "attachments");
    await fs.mkdir(destDir, { recursive: true });
    const bin = path.join(root, "wacli");
    await fs.writeFile(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === "messages" && args[1] === "show") {
  process.stdout.write(JSON.stringify({ success: true, data: { MsgID: get("--id"), ChatJID: "447356168511@s.whatsapp.net", LocalPath: ${JSON.stringify(storeFile)} } }));
}
process.exit(0);
`,
      { mode: 0o755 },
    );

    const cfg = await makeTestConfig("wa-dl-oversize-cfg-", { WHATSAPP_WACLI_BIN: bin });
    const adapter = createWhatsAppAdapter(cfg);

    await expect(
      adapter.downloadAttachment({
        event: {
          source: "whatsapp",
          event_id: "msg-1",
          thread_key: "whatsapp:a:a",
          received_at: "2026-01-01T00:00:00.000Z",
          visibility: "channel",
          mentions_bot: true,
          sender: { source: "whatsapp", id: "sender", display: "S" },
          text: "",
          attachments: [],
          raw_path: "",
          source_thread_ref: whatsappSourceThreadRef({
            chatJid: "447356168511@s.whatsapp.net",
            rootMessageId: "a",
            messageId: "msg-1",
          }),
        },
        // declared size under the limit, but the real file is 5000 bytes
        attachment: { file_id: "wamid-1", filename: "big.bin", size_bytes: 4 },
        destinationDir: destDir,
        maxBytes: 1000,
      }),
    ).rejects.toThrow("exceeds");

    // the oversized copy must not be left behind in the session dir
    const left = await fs.readdir(destDir);
    expect(left).toEqual([]);
  });
});

// ─── sendThreadReply and sendUserMessage interface ──────────────────────────

describe("WhatsAppAdapter send methods exist", () => {
  it("sendThreadReply and sendUserMessage are defined on the adapter", async () => {
    const cfg = await makeTestConfig("wa-send-");
    const adapter = createWhatsAppAdapter(cfg);

    expect(adapter.sendThreadReply).toBeDefined();
    expect(typeof adapter.sendThreadReply).toBe("function");
    expect(adapter.sendUserMessage).toBeDefined();
    expect(typeof adapter.sendUserMessage).toBe("function");
  });

  it("quotes the triggering sender when sending a final reply to a group chat", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-send-group-"));
    const argsFile = path.join(root, "args.txt");
    const bin = path.join(root, "wacli");
    await fs.writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nprintf '{"data":{"id":"sent-1"}}\\n'\n`,
      { mode: 0o755 },
    );

    const cfg = await makeTestConfig("wa-send-group-cfg-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_WACLI_BIN: bin,
    });
    const adapter = createWhatsAppAdapter(cfg);
    (adapter as unknown as { botJid: string }).botJid = "bot@s.whatsapp.net";

    await adapter.sendThreadReply({
      text: "hello",
      event: {
        source: "whatsapp",
        event_id: "msg-1",
        thread_key: "whatsapp:123456789@g.us:123456789@g.us",
        received_at: "2026-01-01T00:00:00.000Z",
        visibility: "channel",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "sender@s.whatsapp.net", display: "Sender" },
        text: "@Felix hello",
        attachments: [],
        raw_path: "",
        source_thread_ref: whatsappSourceThreadRef({
          chatJid: "123456789@g.us",
          rootMessageId: "123456789@g.us",
          messageId: "msg-1",
          senderJid: "sender@s.whatsapp.net",
        }),
      },
    });

    const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
    expect(args).toContain("--reply-to");
    expect(args[args.indexOf("--reply-to") + 1]).toBe("msg-1");
    expect(args).toContain("--reply-to-sender");
    expect(args[args.indexOf("--reply-to-sender") + 1]).toBe("sender@s.whatsapp.net");
    expect(args).not.toContain("--sender");
  });

  it("sends WhatsApp typing presence through wacli and throttles repeats", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-typing-"));
    const argsFile = path.join(root, "args.txt");
    const bin = path.join(root, "wacli");
    await fs.writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argsFile)}\n`,
      { mode: 0o755 },
    );

    const cfg = await makeTestConfig("wa-typing-cfg-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_WACLI_BIN: bin,
    });
    const adapter = createWhatsAppAdapter(cfg);
    const event = {
      source: "whatsapp" as const,
      event_id: "msg-1",
      thread_key: "whatsapp:1234567890@s.whatsapp.net:1234567890@s.whatsapp.net",
      received_at: "2026-01-01T00:00:00.000Z",
      visibility: "dm" as const,
      mentions_bot: true,
      sender: { source: "whatsapp", id: "sender@s.whatsapp.net" },
      text: "hello",
      attachments: [],
      raw_path: "",
      source_thread_ref: whatsappSourceThreadRef({
        chatJid: "1234567890@s.whatsapp.net",
        rootMessageId: "1234567890@s.whatsapp.net",
        messageId: "msg-1",
        senderJid: "sender@s.whatsapp.net",
      }),
    };

    await adapter.sendTyping({ event });
    await adapter.sendTyping({ event });

    const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
    expect(args).toEqual([
      "presence",
      "typing",
      "--to",
      "1234567890@s.whatsapp.net",
    ]);
  });

  it("throttles typing per-chat, not globally", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-typing-perchat-"));
    const argsFile = path.join(root, "args.txt");
    const bin = path.join(root, "wacli");
    await fs.writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argsFile)}\n`,
      { mode: 0o755 },
    );

    const cfg = await makeTestConfig("wa-typing-perchat-cfg-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_WACLI_BIN: bin,
    });
    const adapter = createWhatsAppAdapter(cfg);
    const eventFor = (chatJid: string, eventId: string) => ({
      source: "whatsapp" as const,
      event_id: eventId,
      thread_key: `whatsapp:${chatJid}:${chatJid}`,
      received_at: "2026-01-01T00:00:00.000Z",
      visibility: "dm" as const,
      mentions_bot: true,
      sender: { source: "whatsapp", id: "sender@s.whatsapp.net" },
      text: "hello",
      attachments: [],
      raw_path: "",
      source_thread_ref: whatsappSourceThreadRef({
        chatJid,
        rootMessageId: chatJid,
        messageId: eventId,
        senderJid: "sender@s.whatsapp.net",
      }),
    });

    // Two distinct chats — neither should throttle the other.
    await adapter.sendTyping({ event: eventFor("111@s.whatsapp.net", "a") });
    await adapter.sendTyping({ event: eventFor("222@s.whatsapp.net", "b") });

    const targets = (await fs.readFile(argsFile, "utf8"))
      .trim()
      .split("\n")
      .filter((_, i, arr) => arr[i - 1] === "--to");
    expect(targets).toEqual(["111@s.whatsapp.net", "222@s.whatsapp.net"]);
  });
});
