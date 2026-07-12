import path from "node:path";
import type http from "node:http";
import type { AppConfig } from "../../config.js";
import { log } from "../../lib/log.js";
import type { SourceAdapter, SourceEventStatus, SourceTurnContext } from "../../core/ports.js";
import type { FelixEngine } from "../../engine.js";
import { handleSourceEventIntake, handleSourceReactionIntake } from "../../core/source-intake.js";
import { isOwnerDecisionReactionToken } from "../../slices/approvals/index.js";
import { buildOwnerPermissionNotification } from "../../core/harness-common.js";
import type { SourceMessageAnchor, SourceThreadRef, UniversalAttachment, UniversalEvent } from "../../types.js";
import {
  downloadResponseToFile,
  storedAttachmentPath,
} from "../../core/attachments.js";
import {
  normalizeSourceEvent,
  sourceThreadKey,
  sourceThreadRef,
} from "../../core/source-event-normalization.js";
import { createSourceHost } from "../../core/source-host.js";

// ─── Public constructors ──────────────────────────────────────────────────────

export function createTelegramAdapter(cfg: AppConfig): SourceAdapter {
  return new TelegramAdapter(cfg);
}

export function startTelegramSource(
  cfg: AppConfig,
  engine: FelixEngine,
  adapter?: SourceAdapter,
): Promise<{ stop(): void; done: Promise<void> }> {
  const a = (adapter ?? createTelegramAdapter(cfg)) as TelegramAdapter;
  return a.start(engine);
}

// ─── Webhook handler (module-level, imported by app.ts) ───────────────────────

// Module-level singleton for webhook mode — shares the dedup cache and rate
// limiter across webhook requests instead of creating a new adapter per call.
let webhookAdapter: TelegramAdapter | null = null;

function getWebhookAdapter(cfg: AppConfig): TelegramAdapter {
  if (!webhookAdapter) {
    webhookAdapter = new TelegramAdapter(cfg);
  }
  return webhookAdapter;
}

export async function handleTelegramWebhook(
  cfg: AppConfig,
  engine: FelixEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);

  if (cfg.TELEGRAM_WEBHOOK_SECRET) {
    const secretToken = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
    if (secretToken !== cfg.TELEGRAM_WEBHOOK_SECRET) {
      log.warn("telegram.webhook_invalid_secret");
      sendJson(res, 401, { error: "invalid_secret" });
      return;
    }
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(body);
  } catch {
    log.warn("telegram.webhook_invalid_json");
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  sendJson(res, 200, { ok: true });

  const adapter = getWebhookAdapter(cfg);
  void adapter.processUpdate(engine, update).catch((error) => {
    log.warn("telegram.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
  });
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

const TELEGRAM_API_BASE = "https://api.telegram.org";
const POLLING_TIMEOUT = 30;
const OUTBOUND_MIN_GAP_MS = 1000;
const TYPING_DEDUP_MS = 4000;

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ─── Telegram Bot API types ───────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  message_reaction?: TelegramMessageReaction;
  message_reaction_count?: TelegramReactionCount;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  sticker?: TelegramSticker;
  animation?: TelegramAnimation;
  entities?: TelegramMessageEntity[];
  chat: TelegramChat;
  is_topic_message?: boolean;
  forward_origin?: unknown;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: TelegramPhotoSize;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TelegramPhotoSize;
  mime_type?: string;
  file_size?: number;
}

interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  type: string;
  width: number;
  height: number;
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
  file_size?: number;
}

interface TelegramAnimation {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
}

interface TelegramMessageReaction {
  message_id: number;
  chat: TelegramChat;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
  user?: TelegramUser;
  actor_chat?: TelegramChat;
}

interface TelegramReactionCount {
  message_id: number;
  chat: TelegramChat;
  date: number;
  reactions: TelegramReactionCountEntry[];
}

interface TelegramReactionType {
  type: string;
  emoji?: string;
  custom_emoji_id?: string;
}

interface TelegramReactionCountEntry {
  type: string;
  emoji?: string;
  custom_emoji_id?: string;
  total_count: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ─── TelegramAdapter ──────────────────────────────────────────────────────────

class TelegramAdapter implements SourceAdapter {
  source = "telegram";
  get botUserId(): string | undefined {
    return this.cfg.TELEGRAM_BOT_USER_ID;
  }
  get ownerUserId(): string | undefined {
    return this.cfg.TELEGRAM_OWNER_USER_ID;
  }
  private botId?: number;
  private botUsername?: string;
  private offset = 0;
  private polling = false;
  private lastSendAt = 0;
  private readonly lastTypingAt = new Map<string, number>();
  private readonly host = createSourceHost({ source: "telegram" });

  constructor(private readonly cfg: AppConfig) {}

  // ── Telegram Bot API helpers ────────────────────────────────────────────

  private get apiBase(): string {
    return `${TELEGRAM_API_BASE}/bot${this.cfg.TELEGRAM_BOT_TOKEN}`;
  }

  private async apiCall<T>(method: string, body?: Record<string, unknown>): Promise<T | null> {
    const url = `${this.apiBase}/${method}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) {
        log.warn("telegram.api_error", { method, error: json.description });
        return null;
      }
      return json.result ?? null;
    } catch (error) {
      log.warn("telegram.api_call_failed", {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private sendQueue: Promise<void> = Promise.resolve();

  private async waitForSendSlot(): Promise<void> {
    this.sendQueue = this.sendQueue.then(() => {
      const elapsed = Date.now() - this.lastSendAt;
      const wait = Math.max(0, OUTBOUND_MIN_GAP_MS - elapsed);
      return new Promise<void>((r) => setTimeout(r, wait)).then(() => {
        this.lastSendAt = Date.now();
      });
    });
    return this.sendQueue;
  }

  // ── start (supervisor contract) ──────────────────────────────────────────

  async start(engine: FelixEngine): Promise<{ stop(): void; done: Promise<void> }> {
    if (!this.cfg.TELEGRAM_BOT_TOKEN) {
      log.warn("telegram.disabled", { reason: "missing_token" });
      return { stop: () => undefined, done: Promise.resolve() };
    }

    // Verify bot identity
    const me = await this.apiCall<TelegramUser>("getMe");
    if (!me) {
      log.warn("telegram.disabled", { reason: "auth_failed" });
      return { stop: () => undefined, done: Promise.resolve() };
    }
    this.botId = me.id;
    this.botUsername = me.username;
    log.info("telegram.ready", { user_id: me.id, username: me.username });

    // If owner didn't configure bot user ID, auto-detect
    if (!this.cfg.TELEGRAM_BOT_USER_ID) {
      this.cfg.TELEGRAM_BOT_USER_ID = String(me.id);
    }

    // Delete any existing webhook before starting long-polling
    await this.apiCall("deleteWebhook");

    return this.host.run({
      source: "telegram",
      connect: async () => {
        this.polling = true;
        void this.pollLoop(engine);

        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });

        return {
          disconnect: () => {
            this.polling = false;
            resolveClosed();
          },
          closed,
        };
      },
    });
  }

  private async pollLoop(engine: FelixEngine): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.apiCall<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: POLLING_TIMEOUT,
          allowed_updates: JSON.stringify(["message", "edited_message", "message_reaction"]),
        });
        if (!updates) {
          // API call failed — back off briefly
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.processUpdate(engine, update);
        }
      } catch (error) {
        log.warn("telegram.poll_error", { error: error instanceof Error ? error.message : String(error) });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  // ── Update processing ───────────────────────────────────────────────────

  async processUpdate(engine: FelixEngine, update: TelegramUpdate): Promise<void> {
    // Handle message reactions
    if (update.message_reaction) {
      await this.handleReaction(engine, update.message_reaction);
      return;
    }

    const message = update.message ?? update.edited_message;
    if (!message) return;

    // Skip bot's own messages
    if (message.from?.is_bot) return;

    const messageId = String(message.message_id);
    if (!this.host.firstSight(messageId)) return;

    const event = this.normalizeMessage(message);
    if (!event) return;

    await handleSourceEventIntake(this.cfg, {
      event,
      owner: this.ownerUserId && this.ownerUserId === event.sender.id
        ? { decidedBy: event.sender.id }
        : undefined,
      ports: engine,
    });
  }

  private normalizeMessage(message: TelegramMessage): UniversalEvent | null {
    const chatId = String(message.chat.id);
    const messageId = String(message.message_id);
    const threadId = message.message_thread_id ? String(message.message_thread_id) : chatId;
    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";

    // Determine visibility
    const visibility = isGroup ? "channel" : "dm";

    // Bot mention detection
    const text = message.text ?? message.caption ?? "";
    const mentionsBot = this.botUsername
      ? text.includes(`@${this.botUsername}`)
      : false;

    // Replies to the bot's own messages count as mentions
    const isReplyToBot = this.botId
      ? message.reply_to_message?.from?.id === this.botId
      : false;

    // Build sender
    const sender = this.buildSender(message);

    // Build attachments
    const attachments = this.buildAttachments(message);

    // Build text from all sources
    const messageText = message.text ?? message.caption ?? "";

    return normalizeSourceEvent({
      source: "telegram",
      eventId: messageId,
      receivedAt: new Date(message.date * 1000).toISOString(),
      visibility,
      mentionsBot: mentionsBot || isReplyToBot,
      sender,
      text: messageText,
      attachments,
      thread: {
        source: "telegram",
        conversationId: chatId,
        rootMessageId: threadId,
        messageId,
        raw: {
          chat_id: chatId,
          chat_type: message.chat.type,
          thread_id: threadId,
          user_id: message.from?.id,
          reply_to_message_id: message.reply_to_message?.message_id,
        },
      },
    });
  }

  private buildSender(message: TelegramMessage): { source: string; id: string; display?: string; username?: string } {
    if (message.from) {
      const display = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
      return {
        source: "telegram",
        id: String(message.from.id),
        display: display || undefined,
        username: message.from.username,
      };
    }
    // Channel post without a user sender
    return {
      source: "telegram",
      id: message.sender_chat ? String(message.sender_chat.id) : "unknown",
      display: message.sender_chat?.title ?? message.sender_chat?.username,
      username: message.sender_chat?.username,
    };
  }

  private buildAttachments(message: TelegramMessage): UniversalAttachment[] {
    const attachments: UniversalAttachment[] = [];

    if (message.photo?.length) {
      // Get the largest photo
      const largest = message.photo.reduce((a, b) =>
        (a.file_size ?? 0) > (b.file_size ?? 0) ? a : b,
      );
      attachments.push({
        file_id: largest.file_id,
        filename: `photo_${message.message_id}.jpg`,
        content_type: "image/jpeg",
        size_bytes: largest.file_size,
        is_image: true,
      });
    }

    if (message.document) {
      attachments.push({
        file_id: message.document.file_id,
        filename: message.document.file_name ?? `document_${message.message_id}`,
        content_type: message.document.mime_type,
        size_bytes: message.document.file_size,
      });
    }

    if (message.voice) {
      attachments.push({
        file_id: message.voice.file_id,
        filename: `voice_${message.message_id}.ogg`,
        content_type: message.voice.mime_type ?? "audio/ogg",
        size_bytes: message.voice.file_size,
      });
    }

    if (message.audio) {
      attachments.push({
        file_id: message.audio.file_id,
        filename: message.audio.title
          ? `${message.audio.title}.mp3`
          : `audio_${message.message_id}`,
        content_type: message.audio.mime_type ?? "audio/mpeg",
        size_bytes: message.audio.file_size,
      });
    }

    if (message.video) {
      attachments.push({
        file_id: message.video.file_id,
        filename: `video_${message.message_id}.mp4`,
        content_type: message.video.mime_type ?? "video/mp4",
        size_bytes: message.video.file_size,
      });
    }

    if (message.sticker) {
      attachments.push({
        file_id: message.sticker.file_id,
        filename: `sticker_${message.message_id}`,
        content_type: message.sticker.is_video ? "video/webm" : "image/webp",
        size_bytes: message.sticker.file_size,
      });
    }

    if (message.animation) {
      attachments.push({
        file_id: message.animation.file_id,
        filename: message.animation.file_name ?? `animation_${message.message_id}.gif`,
        content_type: message.animation.mime_type ?? "image/gif",
        size_bytes: message.animation.file_size,
      });
    }

    return attachments;
  }

  // ── Reactions ───────────────────────────────────────────────────────────

  private async handleReaction(engine: FelixEngine, reaction: TelegramMessageReaction): Promise<void> {
    if (!this.ownerUserId) return;
    const senderId = reaction.user ? String(reaction.user.id) : reaction.actor_chat ? String(reaction.actor_chat.id) : undefined;
    if (senderId !== this.ownerUserId) return;

    // Check for new emoji reactions
    const emojiReactions = reaction.new_reaction.filter((r) => r.type === "emoji" && r.emoji);
    if (emojiReactions.length === 0) return;

    // Check if any reaction is a decision token
    const decisionEmoji = emojiReactions.find((r) => isOwnerDecisionReactionToken(r.emoji!));
    if (!decisionEmoji?.emoji) return;

    const chatId = String(reaction.chat.id);
    const messageId = String(reaction.message_id);

    await handleSourceReactionIntake(this.cfg, {
      source: "telegram",
      token: decisionEmoji.emoji,
      decidedBy: senderId,
      anchor: {
        source: "telegram",
        conversation_id: chatId,
        message_id: messageId,
        thread_id: chatId,
      },
      ports: engine,
    });
  }

  // ── SourceAdapter implementation ─────────────────────────────────────────

  async getThreadLink(_threadKey: string): Promise<string | undefined> {
    // Telegram doesn't have direct web links for private chats
    if (this.botUsername) {
      const parts = _threadKey.split(":");
      const chatId = parts[1];
      if (chatId && !chatId.startsWith("-")) {
        return `https://t.me/${this.botUsername}`;
      }
    }
    return undefined;
  }

  async getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext> {
    const chatId = input.event.source_thread_ref.conversation_id;
    const botName = this.botUsername ? `@${this.botUsername}` : "@felix";
    const ownerMentionToken = this.cfg.TELEGRAM_OWNER_USER_ID
      ? `[${this.cfg.TELEGRAM_OWNER_DISPLAY}](tg://user?id=${this.cfg.TELEGRAM_OWNER_USER_ID})`
      : undefined;

    return {
      behaviorInstructions: [
        `T1. For Telegram group messages (visibility: channel), only answer when the post explicitly mentions ${botName}. If not mentioned, output nothing — no FELIX_REPLY, no explanation. In DMs (visibility: dm), answer normally regardless of mention.`,
        "T2. Telegram formatting: use *bold*, _italic_, ~strikethrough~, ```code```, and [link](url) syntax. Telegram supports Markdown-like formatting natively.",
        "T3. Telegram API posting (for intermediate messages only — final replies go through FELIX_REPLY):",
        "```bash",
        `CHAT_ID="${chatId}"`,
        'curl -sS -X POST \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"chat_id":"\'"$CHAT_ID"\'","text":"<message>","parse_mode":"Markdown"}\' \\',
        `  "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage"`,
        "```",
        "Upload files:",
        "```bash",
        `CHAT_ID="${chatId}"`,
        'ARTIFACT_PATH="<path under session artifact directory>"',
        'curl -sS -X POST \\',
        '  -F "chat_id=$CHAT_ID" \\',
        '  -F "document=@${ARTIFACT_PATH}" \\',
        `  "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendDocument"`,
        "```",
        "T4. Keep Telegram replies concise (≤ 500 characters preferred; Telegram's hard text limit is 4096). Long messages degrade readability on mobile.",
        "T4b. For longer outputs (code, logs, stack traces, large file contents), write the content to a file in the session attachments directory and use `sendDocument` to upload it instead of inlining it in the chat message.",
        "T5. When a user sends media (photo, document, voice, video), it is downloaded to the session attachments directory and listed with its local path and MIME type in the turn prompt. For images (MIME `image/*`), open the file directly with your file-reading tool to actually SEE its visual content before answering.",
        ...(ownerMentionToken
          ? [
              `T6. If you emit PERMISSION_REQUIRED, include this exact mention in your preceding FELIX_REPLY: ${ownerMentionToken}. Never fabricate a different owner mention.`,
            ]
          : []),
      ],
    };
  }

  async updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void> {
    const chatId = input.event.source_thread_ref.conversation_id;
    if (!chatId) return;
    const messageId = input.event.event_id;

    // "processing" → set reaction 👀; everything else → remove it
    if (input.status === "processing") {
      await this.waitForSendSlot();
      await this.apiCall("setMessageReaction", {
        chat_id: chatId,
        message_id: Number(messageId),
        reaction: JSON.stringify([{ type: "emoji", emoji: "👀" }]),
      });
    } else {
      await this.waitForSendSlot();
      await this.apiCall("setMessageReaction", {
        chat_id: chatId,
        message_id: Number(messageId),
        reaction: JSON.stringify([]),
      });
    }
  }

  async sendTyping(input: { event: UniversalEvent }): Promise<void> {
    const chatId = input.event.source_thread_ref.conversation_id;
    if (!chatId) return;
    const now = Date.now();
    const last = this.lastTypingAt.get(chatId) ?? 0;
    if (now - last < TYPING_DEDUP_MS) return;
    this.lastTypingAt.set(chatId, now);
    await this.waitForSendSlot();
    await this.apiCall("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });
  }

  async sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void> {
    const chatId = input.event.source_thread_ref.conversation_id;
    if (!chatId) {
      throw new Error("Telegram sendThreadReply: missing conversation_id in source_thread_ref");
    }

    const isGroup = input.event.visibility === "channel";
    const threadId = input.event.source_thread_ref.root_message_id;

    await this.waitForSendSlot();
    await this.apiCall("sendMessage", {
      chat_id: chatId,
      text: input.text,
      parse_mode: "Markdown",
      ...(isGroup && threadId !== chatId ? { message_thread_id: Number(threadId) } : {}),
      reply_parameters: {
        message_id: Number(input.event.event_id),
        allow_sending_without_reply: true,
      },
    });
  }

  async sendUserMessage(input: {
    userId: string;
    text: string;
  }): Promise<SourceMessageAnchor | null> {
    await this.waitForSendSlot();
    const result = await this.apiCall<{ message_id: number; chat: TelegramChat }>("sendMessage", {
      chat_id: input.userId,
      text: input.text,
      parse_mode: "Markdown",
    });
    if (!result) return null;
    return {
      source: "telegram",
      conversation_id: String(result.chat.id),
      message_id: String(result.message_id),
      thread_id: String(result.chat.id),
    };
  }

  async editUserMessage(input: { anchor: SourceMessageAnchor; text: string }): Promise<void> {
    const chatId = input.anchor.conversation_id;
    const messageId = input.anchor.message_id;
    if (!chatId || !messageId) {
      throw new Error("Telegram editUserMessage: missing anchor fields");
    }
    await this.waitForSendSlot();
    await this.apiCall("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: input.text,
      parse_mode: "Markdown",
    });
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
    return buildOwnerPermissionNotification(input);
  }

  async downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
    maxBytes: number;
  }): Promise<UniversalAttachment> {
    this.host.gateAttachment(input.attachment, input.maxBytes);

    // Get file path from Telegram
    const fileInfo = await this.apiCall<TelegramFile>("getFile", {
      file_id: input.attachment.file_id,
    });
    if (!fileInfo?.file_path) {
      throw new Error(`Cannot access Telegram file ${input.attachment.file_id}`);
    }

    const fileUrl = `${TELEGRAM_API_BASE}/file/bot${this.cfg.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const filename = input.attachment.filename ?? path.basename(fileInfo.file_path);
    const dest = storedAttachmentPath(
      input.destinationDir,
      input.event.received_at,
      filename,
      input.attachment.file_id,
    );

    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`download failed for ${input.attachment.file_id}: ${res.status}`);
    }

    const written = await downloadResponseToFile(res, dest, input.maxBytes);
    return {
      ...input.attachment,
      filename,
      size_bytes: input.attachment.size_bytes ?? written,
      local_path: dest,
      status: "available",
    };
  }
}
