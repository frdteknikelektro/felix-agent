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
} from "../src/adapters/whatsapp/index.js";
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
    // Default (no shared number): no name prefix in instructions
    expect(joined).not.toContain("[Felix]");
    expect(joined).toContain("dedicated WhatsApp number");
  });

  it("instructs the name prefix only when the bot shares the owner's number", async () => {
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
    expect(joined).toContain("shares a WhatsApp number");
    expect(joined).toContain("Do NOT call `wacli send text` for your final reply");
    expect(joined).toContain("prefix in file captions");
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

  it("sends WhatsApp typing presence through wacli", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wa-typing-"));
    const argsFile = path.join(root, "args.txt");
    const bin = path.join(root, "wacli");
    await fs.writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`,
      { mode: 0o755 },
    );

    const cfg = await makeTestConfig("wa-typing-cfg-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_WACLI_BIN: bin,
    });
    const adapter = createWhatsAppAdapter(cfg);

    await adapter.sendTyping({
      event: {
        source: "whatsapp",
        event_id: "msg-1",
        thread_key: "whatsapp:1234567890@s.whatsapp.net:1234567890@s.whatsapp.net",
        received_at: "2026-01-01T00:00:00.000Z",
        visibility: "dm",
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
      },
    });

    const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
    expect(args).toEqual([
      "presence",
      "typing",
      "--to",
      "1234567890@s.whatsapp.net",
    ]);
  });
});
