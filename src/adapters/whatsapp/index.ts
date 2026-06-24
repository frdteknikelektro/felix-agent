import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type http from "node:http";
import type { AppConfig } from "../../config.js";
import { writeTextAtomic, ensureDir, safeFileName, readText } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { SourceAdapter, SourceEventStatus, SourceTurnContext } from "../../core/ports.js";
import type { FelixEngine } from "../../engine.js";
import { parseOwnerDecisionAsync } from "../../slices/approvals/index.js";
import { resolvePendingPermissionThreadExact } from "../../slices/approvals/resolve.js";
import { decisionEmoji, decisionLabel, parseDecisionToken } from "../../core/decision.js";
import type { SourceMessageAnchor, SourceThreadRef, UniversalAttachment, UniversalEvent } from "../../types.js";
import { sourceRawDir } from "../../workspace.js";
import {
  AttachmentRejectedError,
  formatBytes,
  storedAttachmentPath,
} from "../../core/attachments.js";

// ─── Public constructors ──────────────────────────────────────────────────────

export function createWhatsAppAdapter(cfg: AppConfig): SourceAdapter {
  return new WhatsAppAdapter(cfg);
}

export function startWhatsAppSource(
  cfg: AppConfig,
  engine: FelixEngine,
  adapter?: SourceAdapter,
): Promise<{ stop(): void; done: Promise<void> }> {
  const a = (adapter ?? createWhatsAppAdapter(cfg)) as WhatsAppAdapter;
  return a.start(engine);
}

// ─── Webhook handler (module-level, imported by app.ts) ───────────────────────

const BOT_MSG_TTL_MS = 60 * 60 * 1000;
let wacliStartedAt: number | null = null;
let webhookSecret: string | null = null;
let ownerSharesNumber = true;
let lastSendAt = 0;
const SEND_MIN_GAP_MS = 5000;

function setWebhookSecret(secret: string): void {
  webhookSecret = secret;
}

function clearWebhookSecret(): void {
  webhookSecret = null;
}

function getBotMessagesDir(cfg: AppConfig): string {
  return path.join(cfg.paths.botMessageIndex, "whatsapp");
}

function botMessageFilePath(cfg: AppConfig, msgId: string): string {
  return path.join(getBotMessagesDir(cfg), `${safeFileName(msgId)}.json`);
}

interface TrackedBotMessage {
  msgId: string;
  threadKey: string;
  trackedAt: string;
}

async function addTrackedBotMessage(cfg: AppConfig, msgId: string, threadKey: string): Promise<void> {
  await ensureDir(getBotMessagesDir(cfg));
  const record: TrackedBotMessage = { msgId, threadKey, trackedAt: new Date().toISOString() };
  await writeTextAtomic(botMessageFilePath(cfg, msgId), JSON.stringify(record));
}

async function removeTrackedBotMessage(cfg: AppConfig, msgId: string): Promise<void> {
  try {
    await fs.unlink(botMessageFilePath(cfg, msgId));
  } catch {
    // best-effort — file may not exist
  }
}

async function hasTrackedBotMessage(cfg: AppConfig, msgId: string): Promise<boolean> {
  try {
    await fs.stat(botMessageFilePath(cfg, msgId));
    return true;
  } catch {
    return false;
  }
}

async function getTrackedBotMessage(
  cfg: AppConfig,
  msgId: string,
): Promise<{ msgId: string; threadKey: string } | undefined> {
  try {
    const raw = await readText(botMessageFilePath(cfg, msgId), "");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as TrackedBotMessage;
    if (!parsed.msgId || !parsed.threadKey) return undefined;
    return { msgId: parsed.msgId, threadKey: parsed.threadKey };
  } catch {
    return undefined;
  }
}

async function cleanupExpiredBotMessages(cfg: AppConfig): Promise<void> {
  const dir = getBotMessagesDir(cfg);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - BOT_MSG_TTL_MS;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath);
      }
    } catch {
      // best-effort
    }
  }
}

async function waitForSendSlot(): Promise<void> {
  const elapsed = Date.now() - lastSendAt;
  if (elapsed < SEND_MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, SEND_MIN_GAP_MS - elapsed));
  }
  lastSendAt = Date.now();
}

export async function handleWhatsAppWebhook(
  cfg: AppConfig,
  engine: FelixEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);

  await cleanupExpiredBotMessages(cfg);

  const botName = cfg.WHATSAPP_BOT_NAME ?? "Felix";
  const botAliases = (cfg.WHATSAPP_BOT_ALIASES ?? "").split(",").map(a => a.trim()).filter(Boolean);

  if (webhookSecret) {
    const signature = req.headers["x-wacli-signature"] as string | undefined;
    if (!signature || !verifyWebhookSignature(body, webhookSecret, signature)) {
      log.warn("whatsapp.webhook_invalid_signature");
      sendJson(res, 401, { error: "invalid_signature" });
      return;
    }
  }

  let payload: ParsedMessage;
  try {
    payload = JSON.parse(body);
  } catch {
    log.warn("whatsapp.webhook_invalid_json");
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const chatJid = payload.Chat || "";
  if (!chatJid || !payload.ID) {
    sendJson(res, 200, { ignored: "missing_fields" });
    return;
  }

  if (chatJid.includes("@broadcast")) {
    sendJson(res, 200, { ignored: "broadcast_chat" });
    return;
  }

  if (wacliStartedAt !== null && payload.Timestamp) {
    const msgTs = Date.parse(payload.Timestamp);
    if (!Number.isNaN(msgTs) && msgTs < wacliStartedAt) {
      sendJson(res, 200, { ignored: "pre_connect_history" });
      return;
    }
  }

  if (payload.FromMe) {
    // ── Self-sent message (Felix prefixes its own messages) ───────────
    const botPrefix = `*[${botName}]* `;
    if ((payload.Text ?? "").startsWith(botPrefix)) {
      sendJson(res, 200, { ignored: "self_message" });
      return;
    }

    // ── Self-sent reaction — unless it's on a bot permission message ──
    if (payload.ReactionToID) {
      const reactionTarget = payload.ReactionToID;
      if (await hasTrackedBotMessage(cfg, reactionTarget)) {
        const botMsg = await getTrackedBotMessage(cfg, reactionTarget);
        if (!botMsg) {
          sendJson(res, 200, { ignored: "self_reaction" });
          return;
        }
        const emoji = payload.ReactionEmoji ?? "";
        const decision = parseDecisionToken(emoji);
        if (decision) {
          sendJson(res, 200, { ok: true });
          const target = {
            kind: "owner_message" as const,
            anchor: {
              source: "whatsapp",
              conversation_id: chatJid,
              message_id: botMsg.msgId,
              thread_id: botMsg.msgId,
            },
          };
          void resolvePendingPermissionThreadExact(cfg, target).then((found) => {
            if (!found) return;
            return engine.handleOwnerDecision({
              mode: decision,
              decidedBy: payload.SenderJID ?? "unknown",
              target,
            });
          }).then(() => removeTrackedBotMessage(cfg, reactionTarget)).catch((error) => {
            log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
          });
          return;
        }
      }
      sendJson(res, 200, { ignored: "self_reaction" });
      return;
    }

    // ── Owner replying to a bot permission-request message ────────────
    if (payload.ReplyToID && await hasTrackedBotMessage(cfg, payload.ReplyToID)) {
      const botMsg = await getTrackedBotMessage(cfg, payload.ReplyToID);
      if (!botMsg) {
        sendJson(res, 200, { ignored: "self_reaction" });
        return;
      }
      const event = normalizeParsedMessage(payload, botName, botAliases);
      if (!event) {
        sendJson(res, 200, { ignored: "empty_event" });
        return;
      }
      sendJson(res, 200, { ok: true });
      const target = {
        kind: "owner_message" as const,
        anchor: {
          source: "whatsapp",
          conversation_id: chatJid,
          message_id: botMsg.msgId,
          thread_id: botMsg.msgId,
        },
      };
      void writeRawWhatsAppEvent(cfg, event).then(() => {
        return resolvePendingPermissionThreadExact(cfg, target).then((found) => {
          if (!found) return;
          return parseOwnerDecisionAsync(event.text, cfg).then((ownerDecision) => {
            if (ownerDecision) {
              return engine.handleOwnerDecision({
                mode: ownerDecision.mode,
                decidedBy: payload.SenderJID ?? "unknown",
                target,
              }).then(() => undefined);
            }
            return engine.ingest(event);
          });
        });
      }).then(() => {
        void removeTrackedBotMessage(cfg, payload.ReplyToID!);
      }).catch((error) => {
        log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }

    // ── Owner using the same number ──────────────────────────────────
    if (ownerSharesNumber) {
      // Media-only self-message (no text/caption) — bot's own outgoing file
      if (payload.Media && !(payload.Text ?? "").trim()) {
        sendJson(res, 200, { ignored: "self_media" });
        return;
      }
      const event = normalizeParsedMessage(payload, botName, botAliases);
      if (!event) {
        sendJson(res, 200, { ignored: "empty_event" });
        return;
      }
      // Shared number: owner and bot share the same JID. Use a distinct
      // sender ID so isOwnMessage doesn't drop owner messages from queue.
      event.sender.id = `owner:${event.sender.id}`;
      sendJson(res, 200, { ok: true });
      void writeRawWhatsAppEvent(cfg, event).then(() => engine.ingest(event)).catch((error) => {
        log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }

    // ── FromMe from a different number → ignore ─────────────────────
    sendJson(res, 200, { ignored: "from_me" });
    return;
  }

  // ── Normal processing (incoming messages from others) ────────────────
  // If this is a reply to a tracked bot message, check for owner decision first
  if (payload.ReplyToID && await hasTrackedBotMessage(cfg, payload.ReplyToID)
      && cfg.WHATSAPP_OWNER_JID && payload.SenderJID === cfg.WHATSAPP_OWNER_JID) {
    const event = normalizeParsedMessage(payload, botName, botAliases);
    if (!event) {
      sendJson(res, 200, { ignored: "empty_event" });
      return;
    }
    sendJson(res, 200, { ok: true });
    const botMsg = await getTrackedBotMessage(cfg, payload.ReplyToID!);
    if (!botMsg) return;
    const target = {
      kind: "owner_message" as const,
      anchor: {
        source: "whatsapp",
        conversation_id: chatJid,
        message_id: botMsg.msgId,
        thread_id: botMsg.msgId,
      },
    };
    void writeRawWhatsAppEvent(cfg, event).then(() => {
      return resolvePendingPermissionThreadExact(cfg, target).then((found) => {
        if (!found) return;
        return parseOwnerDecisionAsync(event.text, cfg).then((ownerDecision) => {
          if (ownerDecision) {
            return engine.handleOwnerDecision({
              mode: ownerDecision.mode,
              decidedBy: payload.SenderJID ?? "unknown",
              target,
            }).then(() => undefined);
          }
          return engine.ingest(event);
        });
      });
    }).then(() => {
      void removeTrackedBotMessage(cfg, payload.ReplyToID!);
    }).catch((error) => {
      log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }

  // If this is a reaction on a tracked bot message from the owner
  if (payload.ReactionToID && await hasTrackedBotMessage(cfg, payload.ReactionToID)
      && cfg.WHATSAPP_OWNER_JID && payload.SenderJID === cfg.WHATSAPP_OWNER_JID) {
    const reactionTarget = payload.ReactionToID;
    const emoji = payload.ReactionEmoji ?? "";
    const decision = parseDecisionToken(emoji);
    if (decision) {
      const botMsg = await getTrackedBotMessage(cfg, reactionTarget);
      if (!botMsg) return;
      sendJson(res, 200, { ok: true });
      const target = {
        kind: "owner_message" as const,
        anchor: {
          source: "whatsapp",
          conversation_id: chatJid,
          message_id: botMsg.msgId,
          thread_id: botMsg.msgId,
        },
      };
      void resolvePendingPermissionThreadExact(cfg, target).then((found) => {
        if (!found) return;
        return engine.handleOwnerDecision({
          mode: decision,
          decidedBy: payload.SenderJID ?? "unknown",
          target,
        });
      }).then(() => removeTrackedBotMessage(cfg, reactionTarget)).catch((error) => {
        log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
      });
    }
    return;
  }

  const event = normalizeParsedMessage(payload, botName, botAliases);
  if (!event) {
    sendJson(res, 200, { ignored: "empty_event" });
    return;
  }

  sendJson(res, 200, { ok: true });
  void writeRawWhatsAppEvent(cfg, event).then(() => engine.ingest(event)).catch((error) => {
    log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
  });
}

// ─── ParsedMessage (webhook payload) ──────────────────────────────────────────

interface ParsedMessage {
  Chat?: string;
  ID?: string;
  SenderJID?: string;
  Timestamp?: string;
  FromMe?: boolean;
  Text?: string;
  PushName?: string;
  ReplyToID?: string;
  ReplyToSenderJID?: string;
  ReplyToDisplay?: string;
  ReactionToID?: string;
  ReactionEmoji?: string;
  IsForwarded?: boolean;
  ForwardingScore?: number;
  Edited?: boolean;
  Revoked?: boolean;
  Media?: {
    Type?: string;
    Caption?: string;
    Filename?: string;
    MimeType?: string;
    DirectPath?: string;
    FileLength?: number;
    MediaKey?: string;
    FileSHA256?: string;
    FileEncSHA256?: string;
  };
}

// ─── WhatsAppAdapter ──────────────────────────────────────────────────────────

class WhatsAppAdapter implements SourceAdapter {
  source = "whatsapp";
  get botUserId(): string | undefined {
    return this.botJid;
  }
  get ownerUserId(): string | undefined {
    return this.cfg.WHATSAPP_OWNER_JID;
  }
  private process?: ReturnType<typeof spawn>;
  private sameNumber = false;
  private botJid?: string;

  constructor(private readonly cfg: AppConfig) {}

  // ── start (supervisor contract) ──────────────────────────────────────────

  async start(engine: FelixEngine): Promise<{ stop(): void; done: Promise<void> }> {
    if (!this.cfg.WHATSAPP_BOT_NAME) {
      log.warn("whatsapp.disabled", { reason: "missing_bot_name" });
      return { stop: () => undefined, done: Promise.resolve() };
    }

    const authOk = checkWacliAuth(this.cfg.WHATSAPP_WACLI_BIN);
    if (!authOk) {
      log.warn("whatsapp.disabled", { reason: "unauthenticated" });
      return { stop: () => undefined, done: Promise.resolve() };
    }

    this.botJid = authOk.jid;
    this.sameNumber = this.cfg.WHATSAPP_OWNER_JID
      ? this.cfg.WHATSAPP_OWNER_JID.startsWith(authOk.jid.split("@")[0])
      : true;
    ownerSharesNumber = this.sameNumber;

    const secret = this.cfg.WHATSAPP_WEBHOOK_SECRET || crypto.randomUUID();
    setWebhookSecret(secret);

    const port = 3000;
    const args = [
      "sync", "--follow",
      "--webhook", `http://127.0.0.1:${port}/webhooks/whatsapp`,
      "--webhook-secret", secret,
      "--webhook-allow-private",
      "--max-reconnect", "0",
    ];

    log.info("whatsapp.starting", { webhook_port: port });
    this.process = spawn(this.cfg.WHATSAPP_WACLI_BIN, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    wacliStartedAt = Date.now();

    this.process!.on("error", (err) => {
      log.warn("whatsapp.process_error", { error: err.message });
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.process!.on("exit", (code) => {
      log.info("whatsapp.process_exit", { code });
      clearWebhookSecret();
      wacliStartedAt = null;
      resolveDone();
    });

    return {
      stop: () => {
        clearWebhookSecret();
        this.process!.kill("SIGTERM");
        wacliStartedAt = null;
        resolveDone();
      },
      done,
    };
  }

  // ── SourceAdapter implementation ─────────────────────────────────────────

  async getThreadLink(_threadKey: string): Promise<string | undefined> {
    return undefined;
  }

  async getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext> {
    const chatJid = input.event.source_thread_ref.conversation_id; // equals thread_key suffix
    const botName = this.cfg.WHATSAPP_BOT_NAME ?? "Felix";
    const aliases = (this.cfg.WHATSAPP_BOT_ALIASES ?? "").split(",").map(a => a.trim()).filter(Boolean);
    const mentionHow = aliases.length > 0
      ? `(e.g. \`@${botName}\`, or \`@${aliases.join("`, `@")}\`)`
      : `(e.g. \`@${botName}\`)`;
    // Only prefix messages when the bot shares a number with its owner — on a
    // dedicated number the sender already identifies the bot. Mirrors the
    // adapter's own send paths (sendThreadReply / sendUserMessage).
    const prefix = this.sameNumber ? `*[${botName}]* ` : "";
    const w4 = this.sameNumber
      ? `W4. This bot shares a WhatsApp number with its owner, so every outgoing message MUST start with the *[${botName}]* prefix — on every send, including any intermediate or supplementary message — to distinguish the bot's messages from the owner's. Send intermediate/progress messages as needed per the output contract.`
      : `W4. This bot has its own dedicated WhatsApp number — do NOT add any name prefix to messages. Send intermediate/progress messages as needed per the output contract.`;

    return {
      behaviorInstructions: [
        `W1. Only answer when @mentioned by name ${mentionHow}. If not mentioned, output nothing — no FELIX_REPLY, no explanation.`,
        "W2. Fetch WhatsApp chat context if needed before answering:",
        "```bash",
        `wacli messages list --chat "${chatJid}" --limit 100 --json`,
        "```",
        "The JSON output has a `.data` array. Each entry has `.msg_id`, `.sender_jid`, `.sender_name`, `.ts` (Unix seconds), `.from_me` (bool), `.text`, `.display_text` (includes reply context), `.quoted_msg_id`, `.media_type`, and `.media_caption`. Sort by `.ts` to reconstruct the timeline.",
        "If the fetch fails, do not claim you read live WhatsApp history. Reply that the history could not be fetched and ask for a retry. Do not use the local thread transcript as a substitute for live WhatsApp history.",
        "W3. WhatsApp formatting: use *bold*, _italic_, ~strikethrough~, ``` `code` ```. Do NOT use Markdown — WhatsApp renders its own formatting natively. Format URLs as plain text — WhatsApp auto-preview links.",
        w4,
        "```bash",
        `wacli send text --to "${chatJid}" \\`,
        `  --message "${prefix}<your message>" \\`,
        '  --json',
        "```",
        "The `--json` flag returns `{\"sent\":true,\"id\":\"<msg_id>\"}`.",
        "To reply to a specific message, add `--reply-to <quoted_msg_id>`. To @mention someone, add `--mention <phone_or_jid>`.",
        "Upload a file:",
        "```bash",
        `wacli send file --to "${chatJid}" \\`,
        '  --file "<path under session artifact directory>" \\',
        `  --caption "${prefix}<optional caption>"`,
        "```",
        ...(this.sameNumber ? [`Always include the *[${botName}]* prefix in file captions.`] : []),
        "W5. When a user sends media (image, document, or other attachment), it is downloaded to the session attachments directory and listed with its local path and MIME type in the turn prompt. Use `file <path>` to identify the media type, `identify <path>` for image metadata, `exiftool <path>` for detailed EXIF, and `bat --style=plain <path>` / `head -c 2000 <path>` for text-based inspection. Do NOT try to open binary files in a text editor.",
        "W6. Keep WhatsApp replies concise (≤ 500 characters preferred). WhatsApp is a mobile-first platform — long messages degrade readability.",
      ],
    };
  }

  async updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void> {
    const chatJid = input.event.source_thread_ref.conversation_id;
    if (!chatJid) return;
    const eventId = input.event.event_id;

    // "processing" → add ⏳; everything else → remove ⏳ (aligns with Discord/Slack/Mattermost)
    const reaction = input.status === "processing" ? "⏳" : "";
    await waitForSendSlot();
    try {
      spawnSync(this.cfg.WHATSAPP_WACLI_BIN, [
        "send", "react",
        "--to", chatJid,
        "--id", eventId,
        "--reaction", reaction,
        "--post-send-wait", "0",
      ], { stdio: "ignore", timeout: 10_000 });
    } catch {
      // best-effort
    }
  }

  async sendTyping(_input: { event: UniversalEvent }): Promise<void> {
    // WhatsApp linked devices have limited presence capabilities
  }

  async sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void> {
    const chatJid = input.event.source_thread_ref.conversation_id;
    if (!chatJid) {
      throw new Error("WhatsApp sendThreadReply: missing conversation_id in source_thread_ref");
    }
    const rootMessageId = input.event.source_thread_ref.root_message_id;
    const replyToArg = rootMessageId && rootMessageId !== input.event.event_id
      ? ["--reply-to", rootMessageId]
      : [];

    const prefix = this.sameNumber ? `*[${this.cfg.WHATSAPP_BOT_NAME ?? "Felix"}]* ` : "";

    const args = [
      "send", "text",
      "--to", chatJid,
      "--message", `${prefix}${input.text}`,
      "--json",
      "--post-send-wait", "0",
      ...replyToArg,
    ];

    await waitForSendSlot();
    try {
      const result = spawnSync(this.cfg.WHATSAPP_WACLI_BIN, args, {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status === 0 && result.stdout) {
        try {
          JSON.parse(result.stdout.trim());
        } catch {
          log.warn("whatsapp.send_reply_parse", { chat_jid: chatJid, stdout: result.stdout?.slice(0, 200) });
        }
      } else {
        const err = result.stderr || `exit ${result.status}`;
        log.warn("whatsapp.send_failed", { chat_jid: chatJid, error: err.trim() });
      }
    } catch (error) {
      log.warn("whatsapp.send_error", {
        chat_jid: chatJid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async sendUserMessage(input: {
    userId: string;
    text: string;
  }): Promise<SourceMessageAnchor | null> {
    const prefix = this.sameNumber ? `*[${this.cfg.WHATSAPP_BOT_NAME ?? "Felix"}]* ` : "";

    const args = [
      "send", "text",
      "--to", input.userId,
      "--message", `${prefix}${input.text}`,
      "--json",
      "--post-send-wait", "0",
    ];

    await waitForSendSlot();
    try {
      const result = spawnSync(this.cfg.WHATSAPP_WACLI_BIN, args, {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status === 0 && result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          if (parsed.id) {
            const anchor: SourceMessageAnchor = {
              source: "whatsapp",
              conversation_id: input.userId,
              message_id: parsed.id,
              thread_id: parsed.id,
            };
            await addTrackedBotMessage(this.cfg, parsed.id, whatsappThreadKey(input.userId));
            return anchor;
          }
        } catch {
          log.warn("whatsapp.send_user_parse", { chat_jid: input.userId, stdout: result.stdout?.slice(0, 200) });
        }
      }
      return null;
    } catch (error) {
      throw new Error(`Unable to send WhatsApp DM to ${input.userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async editUserMessage(input: { anchor: SourceMessageAnchor; text: string }): Promise<void> {
    const chatJid = input.anchor.conversation_id;
    const msgId = input.anchor.message_id;
    if (!chatJid || !msgId) {
      throw new Error("WhatsApp editUserMessage: missing anchor fields");
    }

    const args = [
      "messages", "edit",
      "--chat", chatJid,
      "--id", msgId,
      "--message", input.text,
      "--post-send-wait", "0",
    ];

    try {
      const result = spawnSync(this.cfg.WHATSAPP_WACLI_BIN, args, {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        const err = result.stderr || `exit ${result.status}`;
        throw new Error(`WhatsApp messages edit failed: ${err.trim()}`);
      }
    } catch (error) {
      throw new Error(`WhatsApp messages edit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async formatOwnerNotification(input: {
    skillId: string;
    permissions: string[];
    reason: string;
    requesterName: string;
    requesterId: string;
    threadLink?: string;
    status?: "pending" | "approved" | "rejected";
    decisionMode?: "once" | "always" | "reject";
    decidedAt?: string;
  }): Promise<string> {
    const status = input.status ?? "pending";
    const lines = [
      `*Requester*: ${input.requesterName} (\`${input.requesterId}\`)`,
      `*Skill*: \`${input.skillId}\``,
      `*Permissions*: ${input.permissions.map((p) => `\`${p}\``).join(", ")}`,
      `*Reason*: ${input.reason}`,
      `*Status*: \`${status}\``,
    ];
    if (status !== "pending" && input.decisionMode) {
      lines.push(`*Decision*: ${decisionEmoji(input.decisionMode)} ${decisionLabel(input.decisionMode)}`);
    }
    if (input.decidedAt) {
      lines.push(`*Resolved*: ${input.decidedAt}`);
    }
    if (input.threadLink) {
      lines.push(`*Thread*: ${input.threadLink}`);
    }
    if (status === "pending") {
      lines.push(
        "",
        "Reply `yes` to approve once, `always` to always allow, or `no` to reject.",
        "You can also react with 👌 (once), 👍 (always), or 🙏 (reject).",
      );
    }
    return lines.join("\n");
  }

  async downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
    maxBytes: number;
  }): Promise<UniversalAttachment> {
    const chatJid = input.event.source_thread_ref.conversation_id;
    if (!chatJid) {
      throw new Error("WhatsApp downloadAttachment: missing conversation_id");
    }
    if (typeof input.attachment.size_bytes === "number" && input.attachment.size_bytes > input.maxBytes) {
      throw new AttachmentRejectedError(
        `attachment exceeds ${formatBytes(input.maxBytes)}`,
        `File is ${formatBytes(input.attachment.size_bytes)}, above the ${formatBytes(input.maxBytes)} limit.`,
      );
    }

    const filename = input.attachment.filename ?? input.attachment.file_id;
    const dest = storedAttachmentPath(
      input.destinationDir,
      input.event.received_at,
      filename,
      input.attachment.file_id,
    );
    await ensureDir(path.dirname(dest));

    const args = [
      "media", "download",
      "--chat", chatJid,
      "--id", input.attachment.file_id,
      "--output", dest,
      "--read-only",
    ];

    try {
      const result = spawnSync(this.cfg.WHATSAPP_WACLI_BIN, args, {
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        const err = result.stderr || `exit ${result.status}`;
        throw new Error(`media download failed: ${err.trim()}`);
      }
    } catch (error) {
      log.warn("whatsapp.media_download_failed", {
        chat_jid: chatJid,
        msg_id: input.attachment.file_id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AttachmentRejectedError(
        "Media download failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    }

    return {
      ...input.attachment,
      filename,
      size_bytes: input.attachment.size_bytes,
      local_path: dest,
      status: "available",
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────
}

// ─── Message normalization ────────────────────────────────────────────────────

function normalizeParsedMessage(
  pm: ParsedMessage,
  botName: string,
  aliases: string[] = [],
): UniversalEvent | null {
  const chatJid = pm.Chat || "";
  if (!chatJid) return null;

  const text = pm.Text ?? "";
  const hasText = text.trim().length > 0;
  const hasMedia = Boolean(pm.Media);
  const hasReaction = Boolean(pm.ReactionToID);
  if (!hasText && !hasMedia && !hasReaction) return null;

  const visibility = "channel"; // all WhatsApp chats require @mention; no auto-answer DMs
  const senderJid = pm.SenderJID ?? "unknown";
  const mentionsBot = detectsWhatsappMention(text, botName, aliases);

  const displayText = hasReaction
    ? `[Reacted ${pm.ReactionEmoji ?? "👍"} to ${pm.ReactionToID}]`
    : text;

  const sourceThreadRef = whatsappSourceThreadRef({
    chatJid,
    rootMessageId: chatJid, // WhatsApp threads are flat — one chat = one thread
    messageId: pm.ID ?? "",
    senderJid,
  });

  const attachments: UniversalAttachment[] = pm.Media
    ? [{
        file_id: pm.ID ?? "",
        filename: pm.Media.Filename ?? pm.Media.Caption ?? pm.ID ?? "media",
        content_type: pm.Media.MimeType,
        size_bytes: pm.Media.FileLength,
        is_image: pm.Media.MimeType?.startsWith("image/") ? true : undefined,
      }]
    : [];

  return {
    source: "whatsapp",
    event_id: pm.ID ?? "",
    thread_key: whatsappThreadKey(chatJid),
    received_at: pm.Timestamp
      ? new Date(pm.Timestamp).toISOString()
      : new Date().toISOString(),
    visibility,
    mentions_bot: mentionsBot,
    sender: {
      source: "whatsapp",
      id: senderJid,
      display: pm.PushName,
    },
    text: displayText,
    attachments,
    raw_path: "",
    source_thread_ref: sourceThreadRef,
  };
}

// ─── Raw event persistence ────────────────────────────────────────────────────

async function writeRawWhatsAppEvent(cfg: AppConfig, event: UniversalEvent): Promise<void> {
  const dir = sourceRawDir(cfg.paths, "whatsapp");
  await ensureDir(dir);
  const file = path.join(
    dir,
    `${fsTimestamp(new Date(event.received_at))}_${safeFileName(event.event_id)}.json`,
  );
  event.raw_path = file;
  await writeTextAtomic(file, JSON.stringify(event, null, 2));
}

// ─── Mention detection ────────────────────────────────────────────────────────

export function detectsWhatsappMention(text: string, botName: string, aliases: string[] = []): boolean {
  const lower = text.toLowerCase();
  const botLower = botName.toLowerCase();
  if (lower.includes(`@${botLower}`)) return true;
  for (const alias of aliases) {
    const a = alias.trim().toLowerCase();
    if (a && lower.includes(`@${a}`)) return true;
  }
  return false;
}

// ─── wacli helpers ────────────────────────────────────────────────────────────

interface WacliAuthInfo {
  jid: string;
  connected: boolean;
}

function checkWacliAuth(bin: string): WacliAuthInfo | null {
  try {
    const result = spawnSync(bin, ["doctor", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return null;
    const parsed = JSON.parse(result.stdout.trim());
    const data = (parsed as any)?.data ?? {};
    const jid: string = (data as any)?.linked_jid ?? "";
    const connected: boolean = (data as any)?.connected ?? false;
    if (!jid) return null;
    return { jid, connected };
  } catch {
    return null;
  }
}

// ─── Webhook HMAC verification ────────────────────────────────────────────────

function verifyWebhookSignature(body: string, secret: string, signature: string): boolean {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(signature.slice(prefix.length), "hex");
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), provided);
}

// ─── HTTP utils (for webhook handler, avoid coupling to app.ts) ───────────────

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export function whatsappThreadKey(chatJid: string): string {
  return `whatsapp:${chatJid}:${chatJid}`;
}

export function whatsappSourceThreadRef(opts: {
  chatJid: string;
  rootMessageId: string;
  messageId: string;
  senderJid?: string;
}): SourceThreadRef {
  return {
    source: "whatsapp",
    conversation_id: opts.chatJid,
    thread_id: opts.rootMessageId,
    root_message_id: opts.rootMessageId,
    message_id: opts.messageId,
    raw: {
      chat_jid: opts.chatJid,
      sender_jid: opts.senderJid,
    },
  };
}
