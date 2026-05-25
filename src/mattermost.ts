import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import type { AppConfig } from "./config.js";
import { readText, writeTextAtomic, ensureDir } from "./lib/fs.js";
import { fsTimestamp } from "./lib/time.js";
import { log } from "./lib/log.js";
import type { SourceAdapter } from "./source-adapter.js";
import type { FelixEngine } from "./engine.js";
import type { UniversalAttachment, UniversalEvent } from "./types.js";
import { sourceRawDir } from "./workspace.js";

interface WsPayload {
  event?: string;
  data?: Record<string, unknown>;
  broadcast?: Record<string, unknown>;
  seq?: number;
}

interface MattermostPost {
  id?: string;
  user_id?: string;
  channel_id?: string;
  root_id?: string;
  message?: string;
  file_ids?: string[];
  create_at?: number;
  update_at?: number;
}

interface ChannelInfo {
  id: string;
  type?: string;
  display_name?: string;
  name?: string;
}

export function createMattermostAdapter(cfg: AppConfig): SourceAdapter {
  return new MattermostAdapter(cfg);
}

export function startMattermostSource(cfg: AppConfig, engine: FelixEngine): { stop: () => void } {
  const adapter = createMattermostAdapter(cfg) as MattermostAdapter;
  return adapter.start(engine);
}

class MattermostAdapter implements SourceAdapter {
  source = "mattermost";
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = 1000;
  private seenPosts = new Map<string, number>();
  private channelTypeCache = new Map<string, string | undefined>();
  private fileInfoCache = new Map<string, { name?: string; mime_type?: string; size?: number } | null>();

  constructor(private readonly cfg: AppConfig) {}

  start(engine: FelixEngine): { stop: () => void } {
    if (!this.cfg.MATTERMOST_URL || !this.cfg.MATTERMOST_TOKEN) {
      log.warn("mattermost.disabled", { reason: "missing_url_or_token" });
      return { stop: () => undefined };
    }
    if (!this.cfg.MATTERMOST_BOT_USER_ID) {
      log.warn("mattermost.disabled", { reason: "missing_bot_user_id" });
      return { stop: () => undefined };
    }
    this.connect(engine);
    return {
      stop: () => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.socket?.close();
      },
    };
  }

  getThreadLink(threadKey: string): string | undefined {
    const [source, channelId, rootId] = threadKey.split(":");
    if (source !== "mattermost") return undefined;
    if (!this.cfg.MATTERMOST_URL) return undefined;
    const url = this.cfg.MATTERMOST_URL.replace(/\/$/, "");
    return `${url}/pl/${encodeURIComponent(rootId ?? channelId)}`;
  }

  async sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void> {
    await this.postMessage({
      channel_id: input.event.source_thread.channel_id,
      root_id: input.event.source_thread.root_id,
      message: input.text,
    });
  }

  async sendUserMessage(input: { userId: string; text: string }): Promise<{ post_id: string; channel_id: string } | null> {
    const channelId = await this.resolveDirectChannel(input.userId);
    if (!channelId) {
      throw new Error(`Unable to resolve DM channel for ${input.userId}`);
    }
    return this.postMessage({ channel_id: channelId, message: input.text });
  }

  async addReaction(input: { event: UniversalEvent; emoji: string }): Promise<void> {
    if (!input.event.source_thread.root_id && !input.event.source_thread.user_id) return;
    const postId = input.event.event_id;
    await this.writeReaction("POST", {
      postId,
      emoji: input.emoji,
    });
  }

  async removeReaction(input: { event: UniversalEvent; emoji: string }): Promise<void> {
    const postId = input.event.event_id;
    await this.writeReaction("DELETE", { postId, emoji: input.emoji });
  }

  async downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
  }): Promise<UniversalAttachment> {
    const fileInfo = await this.fetchFileInfo(input.attachment.file_id).catch(() => null);
    const filename = safeFileName(fileInfo?.name ?? input.attachment.filename ?? input.attachment.file_id);
    const dest = path.join(
      input.destinationDir,
      `${fsTimestamp(new Date(input.event.received_at))}_${filename}`,
    );
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/files/${encodeURIComponent(input.attachment.file_id)}/download`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
      },
    });
    if (!res.ok) {
      throw new Error(`download failed for ${input.attachment.file_id}: ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await ensureDir(input.destinationDir);
    await fs.writeFile(dest, buf);
    return {
      file_id: input.attachment.file_id,
      filename,
      content_type: fileInfo?.mime_type ?? input.attachment.content_type,
      size_bytes: fileInfo?.size ?? input.attachment.size_bytes,
      local_path: dest,
      is_image: Boolean(fileInfo?.mime_type?.startsWith("image/") ?? input.attachment.content_type?.startsWith("image/")),
    };
  }

  private connect(engine: FelixEngine): void {
    const url = new URL(this.cfg.MATTERMOST_URL!);
    url.pathname = "/api/v4/websocket";
    url.search = "";
    url.hash = "";
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
      },
    });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectDelay = 1000;
      log.info("mattermost.websocket_open", { url: url.toString() });
    });
    socket.on("message", (chunk) => {
      void this.handleMessage(engine, chunk).catch((error) => {
        log.warn("mattermost.websocket_message_error", { error: error.message });
      });
    });
    socket.on("close", () => {
      this.socket = undefined;
      this.scheduleReconnect(engine);
    });
    socket.on("error", (error) => {
      log.warn("mattermost.websocket_error", { error: error.message });
    });
  }

  private scheduleReconnect(engine: FelixEngine): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(engine), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private async handleMessage(engine: FelixEngine, chunk: WebSocket.RawData): Promise<void> {
    const raw = rawDataToString(chunk);
    const payload = JSON.parse(raw) as WsPayload;
    if (payload.event !== "posted") return;
    const post = await this.normalizePostedEvent(payload);
    if (!post) return;
    if (this.cfg.MATTERMOST_BOT_USER_ID && isSelfMessage(post.sender.id, this.cfg.MATTERMOST_BOT_USER_ID)) {
      return;
    }
    const postId = post.event_id;
    if (this.isDuplicate(postId)) return;
    this.remember(postId);
    await this.writeRawEvent(post);
    if (isOwnerDecisionText(post.text) && this.cfg.MATTERMOST_OWNER_USER_ID === post.sender.id) {
      await engine.handleOwnerDecision(post, parseOwnerDecision(post.text));
      return;
    }
    await engine.ingest(post);
  }

  private async writeRawEvent(event: UniversalEvent): Promise<void> {
    await ensureDir(sourceRawDir(this.cfg.paths, "mattermost"));
    const file = path.join(
      sourceRawDir(this.cfg.paths, "mattermost"),
      `${fsTimestamp(new Date(event.received_at))}_${safeFileName(event.event_id)}.json`,
    );
    event.raw_path = file;
    await writeTextAtomic(file, JSON.stringify(event, null, 2));
  }

  private remember(postId: string): void {
    this.seenPosts.set(postId, Date.now());
  }

  private isDuplicate(postId: string): boolean {
    const seen = this.seenPosts.get(postId);
    return Boolean(seen && Date.now() - seen < 6 * 60 * 60 * 1000);
  }

  private async postMessage(input: {
    channel_id?: string;
    root_id?: string;
    message: string;
  }): Promise<{ post_id: string; channel_id: string } | null> {
    const channelId = input.channel_id;
    if (!channelId) {
      throw new Error("unable to resolve channel");
    }
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/posts`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channelId,
        root_id: input.root_id,
        message: input.message,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`post failed: ${res.status} ${body}`);
    }
    const json = (await res.json().catch(() => null)) as { id?: string; channel_id?: string } | null;
    if (!json?.id) {
      return null;
    }
    return { post_id: json.id, channel_id: json.channel_id ?? channelId };
  }

  private async resolveDirectChannel(userId?: string): Promise<string | undefined> {
    if (!userId || !this.cfg.MATTERMOST_BOT_USER_ID) return undefined;
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/channels/direct`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([this.cfg.MATTERMOST_BOT_USER_ID, userId]),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { id?: string };
    return json.id;
  }

  private async writeReaction(method: "POST" | "DELETE", input: { postId: string; emoji: string }): Promise<void> {
    if (!this.cfg.MATTERMOST_BOT_USER_ID) return;
    const emojiName = normalizeReactionEmoji(input.emoji);
    const url =
      method === "POST"
        ? `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/reactions`
        : `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/users/${encodeURIComponent(this.cfg.MATTERMOST_BOT_USER_ID)}/posts/${encodeURIComponent(input.postId)}/reactions/${encodeURIComponent(emojiName)}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body:
        method === "POST"
          ? JSON.stringify({
              user_id: this.cfg.MATTERMOST_BOT_USER_ID,
              post_id: input.postId,
              emoji_name: emojiName,
            })
          : undefined,
    });
    if (!res.ok && method === "POST") {
      const body = await res.text();
      if (res.status === 404 || body.includes("app.emoji.get_by_name.no_result")) {
        log.warn("mattermost.reaction_missing_emoji", {
          emoji: input.emoji,
          emoji_name: emojiName,
          post_id: input.postId,
        });
        return;
      }
      throw new Error(`reaction failed: ${res.status} ${body}`);
    }
    if (!res.ok && method === "DELETE" && res.status !== 404) {
      const body = await res.text();
      throw new Error(`reaction removal failed: ${res.status} ${body}`);
    }
  }

  private async fetchFileInfo(fileId: string): Promise<{ name?: string; mime_type?: string; size?: number } | null> {
    const cached = this.fileInfoCache.get(fileId);
    if (cached !== undefined) return cached;
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/files/${encodeURIComponent(fileId)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
      },
    });
    if (!res.ok) {
      this.fileInfoCache.set(fileId, null);
      return null;
    }
    const info = (await res.json()) as { name?: string; mime_type?: string; size?: number };
    this.fileInfoCache.set(fileId, info);
    return info;
  }

  private async normalizePostedEvent(payload: WsPayload): Promise<UniversalEvent | null> {
    const data = payload.data ?? {};
    const postRaw = data.post;
    const post = typeof postRaw === "string" ? safeJson(postRaw) : postRaw;
    if (!post || typeof post !== "object") return null;
    const record = post as MattermostPost;
    if (!record.id || !record.user_id || !record.channel_id) return null;
    const message = record.message ?? "";
    const channelType = await this.resolveChannelType(record.channel_id);
    const visibility = channelType === "D" || channelType === "G" || channelType === "P" ? "dm" : "channel";
    const sender = {
      source: "mattermost",
      id: record.user_id,
      username: typeof data.sender_username === "string" ? data.sender_username : undefined,
      display: typeof data.sender_name === "string" ? data.sender_name : record.user_id,
    };
    const rootId = normalizeThreadRootId(record.root_id, record.id);
    const sourceThread = {
      channel_id: record.channel_id,
      root_id: rootId,
      user_id: record.user_id,
    };
    return {
      source: "mattermost",
      event_id: record.id,
      thread_key: threadKey(record.channel_id, rootId),
      received_at: new Date(record.create_at ?? Date.now()).toISOString(),
      visibility,
      mentions_bot: isMentioned(message, sender.username, sender.display),
      sender,
      text: message,
      attachments:
        record.file_ids?.map((fileId) => ({
          file_id: fileId,
          filename: fileId,
        })) ?? [],
      raw_path: "",
      source_thread: sourceThread,
    };
  }

  private async resolveChannelType(channelId: string): Promise<string | undefined> {
    const cached = this.channelTypeCache.get(channelId);
    if (cached !== undefined) return cached;
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/channels/${encodeURIComponent(channelId)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
      },
    });
    if (!res.ok) {
      this.channelTypeCache.set(channelId, undefined);
      return undefined;
    }
    const info = (await res.json()) as ChannelInfo;
    this.channelTypeCache.set(channelId, info.type);
    return info.type;
  }
}

function threadKey(channelId: string, rootId: string): string {
  return `mattermost:${channelId}:${rootId}`;
}

function normalizeThreadRootId(rootId: string | undefined, fallbackId: string): string {
  const trimmed = rootId?.trim();
  return trimmed ? trimmed : fallbackId;
}

function isMentioned(text: string, username?: string, display?: string): boolean {
  const tokens = [username && `@${username}`, display && `@${display}`].filter(Boolean) as string[];
  return tokens.some((token) => text.includes(token));
}

function normalizeReactionEmoji(emoji: string): string {
  switch (emoji) {
    case "⏳":
      return "hourglass_flowing_sand";
    case "🔒":
      return "lock";
    case "⚠️":
      return "warning";
    default:
      return emoji;
  }
}

function rawDataToString(chunk: WebSocket.RawData): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (Array.isArray(chunk)) return Buffer.concat(chunk).toString("utf8");
  return Buffer.from(chunk).toString("utf8");
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isOwnerDecisionText(text: string): boolean {
  return /^\s*(OK once|OK always|REJECT)\s*$/i.test(text.trim());
}

function isSelfMessage(senderId: string, botUserId: string): boolean {
  return senderId === botUserId || senderId.endsWith(`:${botUserId}`);
}

function parseOwnerDecision(text: string): { mode: "once" | "always" | "reject" } {
  if (/^\s*OK always\s*$/i.test(text.trim())) return { mode: "always" };
  if (/^\s*REJECT\s*$/i.test(text.trim())) return { mode: "reject" };
  return { mode: "once" };
}
