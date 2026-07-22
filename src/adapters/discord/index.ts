import { Client, GatewayIntentBits, Partials, Events, type Message } from "discord.js";
import type { AppConfig } from "../../config.js";
import { log } from "../../lib/log.js";
import type { SourceAdapter, SourceEventStatus, SourceTurnContext } from "../../core/ports.js";
import type { FelixEngine } from "../../engine.js";
import { handleSourceEventIntake, handleSourceReactionIntake } from "../../core/source-intake.js";
import { buildOwnerPermissionNotification } from "../../core/harness-common.js";
import { discordMentionToken } from "./mentions.js";
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
import { preferDiscoveredIdentity, type PlatformIdentity } from "../../core/platform-identity.js";

// ─── Public constructors ──────────────────────────────────────────────────────

interface DiscordAdapterDependencies {
  createClient(options: ConstructorParameters<typeof Client>[0]): Client;
}

const DEFAULT_DISCORD_ADAPTER_DEPENDENCIES: DiscordAdapterDependencies = {
  createClient: (options) => new Client(options),
};

export function createDiscordAdapter(
  cfg: AppConfig,
  dependencies: DiscordAdapterDependencies = DEFAULT_DISCORD_ADAPTER_DEPENDENCIES,
): SourceAdapter {
  return new DiscordAdapter(cfg, dependencies);
}

function platformIdentityFromDiscordUser(user: { id: string; username?: string; displayName?: string; globalName?: string | null; tag?: string }): PlatformIdentity {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName || user.globalName || user.tag,
    source: "api",
    discovered: true,
  };
}

function discoverDiscordBotIdentity(client: { user?: Parameters<typeof platformIdentityFromDiscordUser>[0] | null }): PlatformIdentity | undefined {
  return client.user?.id ? platformIdentityFromDiscordUser(client.user) : undefined;
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
  get botIdentity(): PlatformIdentity | undefined {
    return preferDiscoveredIdentity(
      discoverDiscordBotIdentity(this.client ?? {}),
      this.cfg.DISCORD_BOT_USER_ID,
    );
  }
  get botUserId(): string | undefined {
    return this.botIdentity?.userId;
  }
  get ownerUserId(): string | undefined {
    return this.cfg.DISCORD_OWNER_USER_ID;
  }
  get ownerDisplay(): string {
    return this.ownerIdentity?.displayName || this.cfg.DISCORD_OWNER_DISPLAY || "Owner";
  }
  private client?: Client;
  private ownerIdentity?: PlatformIdentity;
  private guildIdCache = new Map<string, string | undefined>();
  private starterMessageCache = new Map<string, string | undefined>();
  private channelTypeCache = new Map<string, "dm" | "channel">();
  private readonly host = createSourceHost({ source: "discord" });

  constructor(
    private readonly cfg: AppConfig,
    private readonly dependencies: DiscordAdapterDependencies,
  ) {}

  // ── start (supervisor contract) ──────────────────────────────────────────

  async start(engine: FelixEngine): Promise<{ stop(): void; done: Promise<void> }> {
    if (!this.cfg.DISCORD_BOT_TOKEN) {
      log.warn("discord.disabled", { reason: "missing_token" });
    }
    return this.host.run({
      source: "discord",
      disabled: !this.cfg.DISCORD_BOT_TOKEN,
      connect: async () => {
        const client = this.dependencies.createClient({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.DirectMessageReactions,
          ],
          partials: [Partials.Channel, Partials.Message, Partials.Reaction],
        });

        client.once(Events.ClientReady, () => {
          log.info("discord.ready", { tag: client.user?.tag });
        });

        client.on(Events.MessageCreate, (message) => {
          void this.handleMessage(engine, message).catch((error) => {
            log.warn("discord.message_handler_error", { error: error.message });
          });
        });

        client.on(Events.MessageReactionAdd, (reaction, user) => {
          void this.handleReactionAdd(engine, reaction, user).catch((error) => {
            log.warn("discord.reaction_handler_error", { error: error.message });
          });
        });

        client.on(Events.Error, (error) => {
          log.warn("discord.client_error", { error: error.message });
        });

        await client.login(this.cfg.DISCORD_BOT_TOKEN);
        await this.discoverOwnerIdentity(client);
        this.client = client;
        return { disconnect: () => client.destroy() };
      },
    });
  }

  private async discoverOwnerIdentity(client: Client): Promise<void> {
    const ownerId = this.cfg.DISCORD_OWNER_USER_ID;
    if (!ownerId) return;
    try {
      const owner = await client.users.fetch(ownerId);
      this.ownerIdentity = platformIdentityFromDiscordUser(owner);
    } catch {
      this.ownerIdentity = undefined;
    }
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
    const botId = this.botUserId ?? "unknown";
    const botMention = `<@${botId}>`;
    const rootMessageId =
      input.event.source_thread_ref.root_message_id ??
      input.event.source_thread_ref.thread_id ??
      input.event.event_id;
    const channelId = input.event.source_thread_ref.conversation_id;
    const ownerMentionToken = discordMentionToken(this.cfg.DISCORD_OWNER_USER_ID);
    return {
      behaviorInstructions: [
        `D1. For Discord channel threads (visibility: channel), only answer when the post explicitly mentions ${botMention}. If not mentioned, output nothing — no FELIX_REPLY, no explanation. In DMs (visibility: dm), answer normally regardless of mention.`,
        `D2. For Discord threads, fetch the current message history before answering. Use a read-only shell script:`,
        "```bash",
        `CHANNEL_ID="${channelId}"`,
        `ROOT_MESSAGE_ID="${rootMessageId}"`,
        'curl -sS -H "Authorization: Bot $DISCORD_BOT_TOKEN" \\',
        '  "https://discord.com/api/v10/channels/$CHANNEL_ID/messages?limit=100"',
        "```",
        "If the fetch fails, do not claim you read live Discord history. Reply that the history could not be fetched and ask for the Discord link or a retry. Do not use the local thread transcript as a substitute for live Discord history.",
        "D3. Discord API posting:",
        "Use the bot token for authorization (already in environment):",
        "```bash",
        `export CHANNEL_ID="${channelId}"`,
        "```",
        "Post text messages (max 2000 characters per message — split longer content into multiple messages):",
        "```bash",
        'curl -sS -X POST \\',
        '  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"content":"<message>"}\' \\',
        '  "https://discord.com/api/v10/channels/$CHANNEL_ID/messages"',
        "```",
        "Upload files:",
        "```bash",
        'ARTIFACT_PATH="<path under session artifact directory>"',
        'curl -sS -X POST \\',
        '  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \\',
        '  -F "file=@${ARTIFACT_PATH}" \\',
        '  -F \'payload_json={"content":"<optional caption>"}\' \\',
        '  "https://discord.com/api/v10/channels/$CHANNEL_ID/messages"',
        "```",
        ...(ownerMentionToken
          ? [
              `D4. If you emit PERMISSION_REQUIRED, include this exact mention token in your preceding FELIX_REPLY: ${ownerMentionToken}. Never fabricate a different owner mention, and never mention the owner in any other circumstance.`,
            ]
          : []),
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

    // Discord renders CommonMark natively, so no dialect conversion is needed.
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

  async editUserMessage(input: { anchor: SourceMessageAnchor; text: string }): Promise<void> {
    const channelId = input.anchor.conversation_id;
    const messageId = input.anchor.message_id;
    if (!channelId || !messageId) {
      throw new Error("Discord editUserMessage: missing anchor fields");
    }
    if (!this.client) {
      throw new Error("Discord client not connected");
    }
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel ${channelId} not found or not text-based`);
    }
    const msg = await (channel as any).messages.fetch(messageId);
    await msg.edit({ content: input.text });
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

  private async handleReactionAdd(
    engine: FelixEngine,
    reaction: any,
    user: any,
  ): Promise<void> {
    if (!this.ownerUserId || user.id !== this.ownerUserId) return;
    if (reaction.partial) {
      await reaction.fetch().catch(() => null);
    }
    const message = reaction.message;
    if (!message?.author?.id || this.botUserId && message.author.id !== this.botUserId) {
      return;
    }
    await handleSourceReactionIntake(this.cfg, {
      source: "discord",
      token: reaction.emoji.name ?? reaction.emoji.identifier ?? "",
      decidedBy: user.id,
      anchor: {
        source: "discord",
        conversation_id: message.channel.id,
        message_id: message.id,
        thread_id: message.id,
      },
      ports: engine,
    });
  }

  async downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
    maxBytes: number;
  }): Promise<UniversalAttachment> {
    const channelId = input.event.source_thread_ref.conversation_id;
    if (!channelId) {
      throw new Error("Discord downloadAttachment: missing conversation_id");
    }
    this.host.gateAttachment(input.attachment, input.maxBytes);
    const url = `https://cdn.discordapp.com/attachments/${encodeURIComponent(channelId)}/${encodeURIComponent(input.attachment.file_id)}/${encodeURIComponent(input.attachment.filename ?? input.attachment.file_id)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`download failed for ${input.attachment.file_id}: ${res.status}`);
    }
    const filename = input.attachment.filename ?? input.attachment.file_id;
    const dest = storedAttachmentPath(
      input.destinationDir,
      input.event.received_at,
      filename,
      input.attachment.file_id,
    );
    const written = await downloadResponseToFile(res, dest, input.maxBytes);
    return {
      ...input.attachment,
      filename,
      size_bytes: input.attachment.size_bytes ?? written,
      local_path: dest,
      status: "available",
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
    if (!this.host.firstSight(messageId)) return;

    const event = await this.normalizeDiscordMessage(message);
    if (!event) return;

    await handleSourceEventIntake(this.cfg, {
      event,
      owner: this.ownerUserId && this.ownerUserId === event.sender.id
        ? { decidedBy: event.sender.id }
        : undefined,
      ports: engine,
    });
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
    const botId = this.botUserId ?? this.client?.user?.id;
    const mentionsBot = botId ? message.mentions.users.has(botId) : false;

    return normalizeSourceEvent({
      source: "discord",
      eventId: message.id,
      receivedAt: new Date(message.createdTimestamp).toISOString(),
      visibility,
      mentionsBot,
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
      thread: {
        source: "discord",
        conversationId: channelId,
        rootMessageId,
        messageId: message.id,
        raw: {
          channel_id: channelId,
          root_id: rootMessageId,
          guild_id: guildId,
          user_id: message.author.id,
        },
      },
    });
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
  return sourceThreadKey("discord", channelId, rootMessageId);
}

export function discordSourceThreadRef(opts: {
  channelId: string;
  rootMessageId: string;
  messageId: string;
  guildId?: string;
  authorId?: string;
}): SourceThreadRef {
  return sourceThreadRef({
    source: "discord",
    conversationId: opts.channelId,
    rootMessageId: opts.rootMessageId,
    messageId: opts.messageId,
    raw: {
      channel_id: opts.channelId,
      root_id: opts.rootMessageId,
      guild_id: opts.guildId,
      user_id: opts.authorId,
    },
  });
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
