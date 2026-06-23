import { describe, expect, it } from "vitest";
import {
  createWhatsAppAdapter,
  whatsappThreadKey,
  whatsappSourceThreadRef,
  detectsWhatsappMention,
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
    expect(joined).toContain("wacli send text");
    expect(joined).toContain("--json");
    expect(joined).toContain("[Felix]");
  });

  it("includes owner info when WHATSAPP_OWNER_JID is set", async () => {
    const cfg = await makeTestConfig("wa-turnctx2-", {
      WHATSAPP_BOT_NAME: "Felix",
      WHATSAPP_OWNER_JID: "9876543210@s.whatsapp.net",
      WHATSAPP_OWNER_DISPLAY: "MyOwner",
    });
    const adapter = createWhatsAppAdapter(cfg);
    const ctx = await adapter.getTurnContext({
      event: {
        source: "whatsapp",
        event_id: "evt-1",
        thread_key: "whatsapp:1234567890@s.whatsapp.net:1234567890@s.whatsapp.net",
        received_at: "2026-06-01T00:00:00.000Z",
        visibility: "dm",
        mentions_bot: true,
        sender: { source: "whatsapp", id: "sender-1" },
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

    expect(ctx.owner).toBeDefined();
    expect(ctx.owner!.userId).toBe("9876543210@s.whatsapp.net");
    expect(ctx.owner!.display).toBe("MyOwner");
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

    expect(msg).toContain("*Requester*: Alice");
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

    expect(msg).toContain("*Status*: `approved`");
    expect(msg).toContain("*Decision*:");
  });
});
