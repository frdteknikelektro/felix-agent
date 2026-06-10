import fs from "node:fs/promises";
import path from "node:path";
import { Client, GatewayIntentBits, Events, type Message } from "discord.js";
import type { AppConfig } from "../../config.js";
import { writeTextAtomic, ensureDir } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { SourceAdapter, SourceEventStatus, SourceTurnContext } from "../../core/ports.js";
import type { FelixEngine } from "../../engine.js";
import { parseOwnerDecisionAsync } from "../../slices/approvals/index.js";
export { discordMentionToken } from "./mentions.js";
import type { SourceMessageAnchor, SourceThreadRef, UniversalAttachment, UniversalEvent } from "../../types.js";
import { sourceRawDir } from "../../workspace.js";

// ─── Public constructors ──────────────────────────────────────────────────────

export function createDiscordAdapter(cfg: AppConfig): SourceAdapter {
  return new DiscordAdapter(cfg);
}

export function startDiscordSource(
  cfg: AppConfig,
  engine: FelixEngine,
  adapter?: SourceAdapter,
): Promise<{ stop(): void; done: Promise<void> }> {
  const a = (adapter ?? createDiscordAdapter(cfg)) as DiscordAdapter;
  return a.start(engine);
}

// ─── DiscordAdapter ───────────────────────────────────────────────────────────

class DiscordAdapter implements SourceAdapter {
  source = "discord";
  get botUserId(): string | undefined {
    return this.cfg.DISCORD_BOT_USER_ID;
  }
  get ownerUserId(): string | undefined {
    return this.cfg.DISCORD_OWNER_USER_ID;
  }
  private client?: Client;
  private guildIdCache = new Map<string, string | undefined>();
  private starterMessageCache = new Map<string, string | undefined>();
  private seenMessages = new Map<string, number>();
  private channelTypeCache = new Map<string, "dm" | "channel">();

  constructor(private readonly cfg: AppConfig) {}

  // ── start (supervisor contract) ──────────────────────────────────────────

  async start(engine: FelixEngine): Promise<{ stop(): void; done: Promise<void> }> {
    if (!this.cfg.DISCORD_TOKEN) {
      log.warn("discord.disabled", { reason: "missing_token" });
      return { stop: () => undefined, done: Promise.resolve() };
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    client.once(Events.ClientReady, () => {
      log.info("discord.ready", { tag: client.user?.tag });
    });

    client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(engine, message).catch((error) => {
        log.warn("discord.message_handler_error", { error: error.message });
      });
    });

    client.on(Events.Error, (error) => {
      log.warn("discord.client_error", { error: error.message });
    });

    await client.login(this.cfg.DISCORD_TOKEN);
    this.client = client;

    return {
      stop: () => {
        client.destroy();
        resolveDone();
      },
      done,
    };
  }

  // ── SourceAdapter implementation ─────────────────────────────────────────

  async getThreadLink(threadKey: string): Promise<string | undefined> {
    const [source, channelId, rootId] = threadKey.split(":");
    if (source !== "discord") return undefined;
    const guildId = this.guildIdCache.get(channelId) ?? "@me";
    const guildSegment = guildId === "@me" ? "@me" : encodeURIComponent(guildId);
    return `https://discord.com/channels/${guildSegment}/${encodeURIComponent(channelId)}/${encodeURIComponent(rootId)}`;
  }

  async getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext> {
    const botId = this.cfg.DISCORD_BOT_USER_ID ?? "unknown";
    const botMention = `<@${botId}>`;
    const rootMessageId =
      input.event.source_thread_ref.root_message_id ??
      input.event.source_thread_ref.thread_id ??
      input.event.event_id;
    const channelId = input.event.source_thread_ref.conversation_id;

    return {
      behaviorInstructions: [
        `9. For Discord channel threads (visibility: channel), only answer when the post explicitly mentions ${botMention}. If not mentioned, output nothing — no FELIX_REPLY, no explanation. In DMs (visibility: dm), answer normally regardless of mention.`,
        `10. For Discord threads, fetch the current message history before answering. Use a read-only shell script:`,
        "```bash",
        "set -a",
        "source /run/secrets/.env",
        "set +a",
        `CHANNEL_ID="${channelId}"`,
        `ROOT_MESSAGE_ID="${rootMessageId}"`,
        'curl -sS -H "Authorization: Bot $DISCORD_TOKEN" \\',
        '  "https://discord.com/api/v10/channels/$CHANNEL_ID/messages?limit=100"',
        "```",
        "If the fetch fails, do not claim you read live Discord history. Reply that the history could not be fetched and ask for the Discord link or a retry. Do not use the local thread transcript as a substitute for live Discord history.",
        "11. Discord Source API posting: when a skill produces useful intermediate results, you may post them directly to the current Discord channel before the final FELIX_REPLY.",
        "Use the bot token for authorization:",
        "```bash",
        "set -a",
        "source /run/secrets/.env",
        "set +a",
        `export CHANNEL_ID="${channelId}"`,
        "```",
        "Post text messages (max 2000 characters per message — split longer content into multiple messages):",
        "```bash",
        'curl -sS -X POST \\',
        '  -H "Authorization: Bot $DISCORD_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"content":"<message>"}\' \\',
        '  "https://discord.com/api/v10/channels/$CHANNEL_ID/messages"',
        "```",
        "Upload files:",
        "```bash",
        'ARTIFACT_PATH="<path under session artifact directory>"',
        'curl -sS -X POST \\',
        '  -H "Authorization: Bot $DISCORD_TOKEN" \\',
        '  -F "file=@${ARTIFACT_PATH}" \\',
        '  -F \'payload_json={"content":"<optional caption>"}\' \\',
        '  "https://discord.com/api/v10/channels/$CHANNEL_ID/messages"',
        "```",
        "After direct Discord posts or uploads, the final FELIX_REPLY should be concise and mention what was posted. Do not duplicate large report or artifact content in the final reply.",
      ],
    };
  }

  async updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void> {
    if (input.status === "processing") {
      await this.addReaction(input.event, "⏳");
      return;
    }
    await this.removeReaction(input.event, "⏳");
  }

  async sendTyping(input: { event: UniversalEvent }): Promise<void> {
    const channelId = input.event.source_thread_ref.conversation_id;
    if (!channelId || !this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as any).sendTyping();
      }
    } catch {
      // typing indicator is best-effort
    }
  }

  async sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void> {
    const channelId = input.event.source_thread_ref.conversation_id;
    if (!channelId) {
      throw new Error("Discord sendThreadReply: missing conversation_id in source_thread_ref");
    }
    if (!this.client) {
      throw new Error("Discord client not connected");
    }
    const rootMessageId = input.event.source_thread_ref.root_message_id;
    const messageId = input.event.source_thread_ref.message_id;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel ${channelId} not found or not text-based`);
    }

    const isThread = channel.isThread();
    const isRoot = rootMessageId === messageId || !rootMessageId;
    const replyOptions = !isThread && !isRoot
      ? { reply: { messageReference: rootMessageId! } }
      : {};

    const chunks = splitLongDiscordMessage(input.text, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const options = i === 0 ? replyOptions : {};
      await (channel as any).send({ content: chunks[i], ...options });
    }
  }

  async sendUserMessage(input: {
    userId: string;
    text: string;
  }): Promise<SourceMessageAnchor | null> {
    if (!this.client) return null;
    const user = await this.client.users.fetch(input.userId).catch(() => null);
    if (!user) {
      throw new Error(`Unable to resolve Discord user ${input.userId}`);
    }
    const chunks = splitLongDiscordMessage(input.text, 2000);
    let message: Message | undefined;
    for (let i = 0; i < chunks.length; i++) {
      message = await user.send(chunks[i]);
    }
    if (!message) return null;
    return {
      source: "discord",
      conversation_id: message.channel.id,
      message_id: message.id,
      thread_id: message.id,
    };
  }

  async downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
  }): Promise<UniversalAttachment> {
    const channelId = input.event.source_thread_ref.conversation_id;
    if (!channelId) {
      throw new Error("Discord downloadAttachment: missing conversation_id");
    }
    const url = `https://cdn.discordapp.com/attachments/${encodeURIComponent(channelId)}/${encodeURIComponent(input.attachment.file_id)}/${encodeURIComponent(input.attachment.filename ?? input.attachment.file_id)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`download failed for ${input.attachment.file_id}: ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(
      input.destinationDir,
      `${fsTimestamp(new Date(input.event.received_at))}_${safeFileName(input.attachment.filename ?? input.attachment.file_id)}`,
    );
    await ensureDir(input.destinationDir);
    await fs.writeFile(dest, buf);
    return {
      ...input.attachment,
      local_path: dest,
    };
  }

  // ── Internal: message handling ───────────────────────────────────────────

  private async handleMessage(engine: FelixEngine, message: Message): Promise<void> {
    if (message.partial) {
      try {
        await message.fetch();
      } catch {
        return;
      }
    }
    if (message.author.bot) return;

    const messageId = message.id;
    if (this.isDuplicate(messageId)) return;
    this.remember(messageId);

    const event = await this.normalizeDiscordMessage(message);
    if (!event) return;

    await this.writeRawEvent(event);

    const ownerDecision = await parseOwnerDecisionAsync(event.text, this.cfg);
    if (ownerDecision && this.ownerUserId === event.sender.id) {
      const target = {
        kind: "owner_message" as const,
        anchor: {
          source: "discord",
          conversation_id: event.source_thread_ref.conversation_id,
          message_id: event.source_thread_ref.root_message_id ?? event.source_thread_ref.message_id,
          thread_id: event.source_thread_ref.thread_id,
        },
      };
      if (await engine.hasPendingPermission(target)) {
        await engine.handleOwnerDecision({
          mode: ownerDecision.mode,
          decidedBy: event.sender.id,
          target,
        });
        return;
      }
    }

    await engine.ingest(event);
  }

  private async normalizeDiscordMessage(message: Message): Promise<UniversalEvent | null> {
    const channelId = message.channel.id;
    const guildId = message.guildId ?? undefined;

    if (!message.content && message.attachments.size === 0) return null;

    // Cache guild id for thread-link construction
    if (guildId) {
      this.guildIdCache.set(channelId, guildId);
    }

    // Determine visibility
    const cachedType = this.channelTypeCache.get(channelId);
    const isDM = cachedType === "dm" || !guildId;
    if (!cachedType) {
      this.channelTypeCache.set(channelId, isDM ? "dm" : "channel");
    }
    const visibility = isDM ? "dm" : "channel";

    // Determine root message ID
    let rootMessageId: string;
    if (message.channel.isThread()) {
      const cached = this.starterMessageCache.get(channelId);
      if (cached) {
        rootMessageId = cached;
      } else {
        try {
          const starter = await message.channel.fetchStarterMessage();
          const starterId = starter?.id ?? message.id;
          this.starterMessageCache.set(channelId, starterId);
          rootMessageId = starterId;
        } catch {
          rootMessageId = message.id;
          this.starterMessageCache.set(channelId, rootMessageId);
        }
      }
    } else if (message.reference?.messageId) {
      rootMessageId = message.reference.messageId;
    } else {
      rootMessageId = message.id;
    }

    // Bot mention detection
    const botId = this.cfg.DISCORD_BOT_USER_ID ?? this.client?.user?.id;
    const mentionsBot = botId ? message.mentions.users.has(botId) : false;

    const sourceThreadRef = discordSourceThreadRef({
      channelId,
      rootMessageId,
      messageId: message.id,
      guildId,
      authorId: message.author.id,
    });

    return {
      source: "discord",
      event_id: message.id,
      thread_key: discordThreadKey(channelId, rootMessageId),
      received_at: new Date(message.createdTimestamp).toISOString(),
      visibility,
      mentions_bot: mentionsBot,
      sender: {
        source: "discord",
        id: message.author.id,
        display: message.author.displayName,
        username: message.author.username,
      },
      text: message.content,
      attachments: message.attachments.map((att) => ({
        file_id: att.id,
        filename: att.name,
        content_type: att.contentType ?? undefined,
        size_bytes: att.size,
        is_image: att.contentType?.startsWith("image/") ?? undefined,
      })),
      raw_path: "",
      source_thread_ref: sourceThreadRef,
    };
  }

  // ── Internal: raw event persistence ──────────────────────────────────────

  private async writeRawEvent(event: UniversalEvent): Promise<void> {
    await ensureDir(sourceRawDir(this.cfg.paths, "discord"));
    const file = path.join(
      sourceRawDir(this.cfg.paths, "discord"),
      `${fsTimestamp(new Date(event.received_at))}_${safeFileName(event.event_id)}.json`,
    );
    event.raw_path = file;
    await writeTextAtomic(file, JSON.stringify(event, null, 2));
  }

  // ── Internal: dedup ──────────────────────────────────────────────────────

  private remember(messageId: string): void {
    this.seenMessages.set(messageId, Date.now());
  }

  private isDuplicate(messageId: string): boolean {
    const seen = this.seenMessages.get(messageId);
    return Boolean(seen && Date.now() - seen < 6 * 60 * 60 * 1000);
  }

  // ── Internal: reactions ──────────────────────────────────────────────────

  private async addReaction(event: UniversalEvent, emoji: string): Promise<void> {
    if (!this.client) return;
    const channelId = event.source_thread_ref.conversation_id;
    if (!channelId) return;
    const messageId = event.event_id;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const msg = await (channel as any).messages.fetch(messageId);
      await msg.react(emoji);
    } catch (error) {
      log.warn("discord.reaction_failed", {
        channel_id: channelId,
        message_id: messageId,
        emoji,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async removeReaction(event: UniversalEvent, emoji: string): Promise<void> {
    if (!this.client) return;
    const channelId = event.source_thread_ref.conversation_id;
    if (!channelId) return;
    const messageId = event.event_id;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const msg = await (channel as any).messages.fetch(messageId);
      const reaction = msg.reactions.cache.get(emoji);
      if (reaction && this.client?.user) {
        await reaction.users.remove(this.client.user.id);
      }
    } catch (error) {
      log.warn("discord.reaction_remove_failed", {
        channel_id: channelId,
        message_id: messageId,
        emoji,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export function discordThreadKey(channelId: string, rootMessageId: string): string {
  return `discord:${channelId}:${rootMessageId}`;
}

export function discordSourceThreadRef(opts: {
  channelId: string;
  rootMessageId: string;
  messageId: string;
  guildId?: string;
  authorId?: string;
}): SourceThreadRef {
  return {
    source: "discord",
    conversation_id: opts.channelId,
    thread_id: opts.rootMessageId,
    root_message_id: opts.rootMessageId,
    message_id: opts.messageId,
    raw: {
      channel_id: opts.channelId,
      root_id: opts.rootMessageId,
      guild_id: opts.guildId,
      user_id: opts.authorId,
    },
  };
}

// ─── Internal utilities ──────────────────────────────────────────────────────

function splitLongDiscordMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const cut = remaining.lastIndexOf("\n", limit);
    const splitAt = cut > limit / 2 ? cut + 1 : limit; // +1 to consume the newline
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
