import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import type { AppConfig } from "../../config.js";
import { readText, writeTextAtomic, ensureDir } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { SourceAdapter, SourceEventStatus, SourceTurnContext } from "../../core/ports.js";
import type { FelixEngine } from "../../engine.js";
import { parseOwnerDecision, parseOwnerDecisionAsync } from "../../slices/approvals/index.js";
import { mattermostMentionTokens, normalizeMattermostName } from "./mentions.js";
export { mattermostMentionToken, mattermostMentionTokens } from "./mentions.js";
import type { SourceMessageAnchor, SourceThreadRef, UniversalAttachment, UniversalEvent } from "../../types.js";
import { sourceRawDir } from "../../workspace.js";

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
  team_id?: string;
}

interface MattermostMe {
  id?: string;
  username?: string;
  display_name?: string;
  nickname?: string;
}

interface MattermostIdentity {
  userId: string;
  username?: string;
  displayName?: string;
  mentionTokens: string[];
}

export function createMattermostAdapter(cfg: AppConfig): SourceAdapter {
  return new MattermostAdapter(cfg);
}

export function startMattermostSource(
  cfg: AppConfig,
  engine: FelixEngine,
): Promise<{ stop(): void; done: Promise<void> }> {
  const adapter = createMattermostAdapter(cfg) as MattermostAdapter;
  return adapter.start(engine);
}

class MattermostAdapter implements SourceAdapter {
  source = "mattermost";
  get botUserId(): string | undefined {
    return this.cfg.MATTERMOST_BOT_USER_ID;
  }
  get ownerUserId(): string | undefined {
    return this.cfg.MATTERMOST_OWNER_USER_ID;
  }
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = 1000;
  private seenPosts = new Map<string, number>();
  private channelTypeCache = new Map<string, string | undefined>();
  private channelTeamIdCache = new Map<string, string | undefined>();
  private channelTeamCache = new Map<string, string | undefined>();
  private teamNameCache = new Map<string, string | undefined>();
  private fileInfoCache = new Map<string, { name?: string; mime_type?: string; size?: number } | null>();
  private botIdentity: MattermostIdentity | null = null;
  private botIdentityPromise?: Promise<MattermostIdentity | null>;

  constructor(private readonly cfg: AppConfig) {}

  async start(engine: FelixEngine): Promise<{ stop(): void; done: Promise<void> }> {
    if (!this.cfg.MATTERMOST_URL || !this.cfg.MATTERMOST_TOKEN) {
      log.warn("mattermost.disabled", { reason: "missing_url_or_token" });
      return { stop: () => undefined, done: Promise.resolve() };
    }
    const identity = await this.ensureBotIdentity();
    if (!identity?.userId) {
      log.warn("mattermost.disabled", { reason: "missing_bot_identity" });
      return { stop: () => undefined, done: Promise.resolve() };
    }
    await this.prefetchBotTeams();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.connect(engine);
    return {
      stop: () => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.socket?.close();
        resolveDone();
      },
      done,
    };
  }

  async getThreadLink(threadKey: string): Promise<string | undefined> {
    const [source, channelId, rootId] = threadKey.split(":");
    if (source !== "mattermost") return undefined;
    if (!this.cfg.MATTERMOST_URL) return undefined;
    const postId = rootId ?? channelId;
    let teamName = this.channelTeamCache.get(channelId ?? "");
    if (teamName === undefined && !this.channelTeamCache.has(channelId ?? "")) {
      const teamId = await this.resolvePostTeamId(postId);
      if (teamId) {
        teamName = await this.resolveTeamName(teamId);
      }
      this.channelTeamCache.set(channelId ?? "", teamName);
    }
    return buildThreadLink(this.cfg.MATTERMOST_URL, postId, teamName);
  }

  async getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext> {
    const mentionTokens = mattermostMentionTokens(this.cfg.MATTERMOST_BOT_USERNAME, this.cfg.MATTERMOST_BOT_DISPLAY);
    const botMentionText =
      mentionTokens.length === 0
        ? "@Felix"
        : mentionTokens.length === 1
          ? mentionTokens[0]
          : `${mentionTokens[0]} or ${mentionTokens[1]}`;
    const rootPostId =
      input.event.source_thread_ref.root_message_id ??
      input.event.source_thread_ref.thread_id ??
      input.event.event_id;
    const channelId = input.event.source_thread_ref.conversation_id;
    return {
      behaviorInstructions: [
        `9. For Mattermost channel threads (visibility: channel), only answer when the post explicitly mentions ${botMentionText}. If not mentioned, output nothing — no FELIX_REPLY, no explanation. In DMs (visibility: dm), answer normally regardless of mention.`,
        `10. For Mattermost public threads, when a post mentions ${botMentionText}, fetch the current thread history before answering. Use a read-only shell script or command sequence like this:`,
        "```bash",
        `THREAD_POST_ID="${rootPostId}"`,
        'curl -sS -H "Authorization: Bearer $MATTERMOST_TOKEN" \\',
        '  "$MATTERMOST_URL/api/v4/posts/$THREAD_POST_ID/thread"',
        "```",
        "If the fetch fails, do not claim you read live Mattermost history. Reply that the thread could not be fetched and ask for the Mattermost link or a retry. Do not use the local thread transcript as a substitute for live Mattermost history in that case.",
        "Use the fetched thread history only as context for the current turn. Limit the fetch to the current thread only and do not persist the fetched history unless it is required for the current turn.",
        "11. Source API posting for Mattermost: when a skill produces useful intermediate status, images, PDFs, or other generated session artifacts, you may post them directly to the current Mattermost thread before the final FELIX_REPLY.",
        "Use source API posting only for the active Mattermost thread and only for files generated for this current session/request. Never upload secrets, credential files, raw env files, unrelated repo files, or arbitrary readable files.",
        "For Mattermost source API posting, use MATTERMOST_URL and MATTERMOST_TOKEN (already in environment):",
        "```bash",
        `MATTERMOST_CHANNEL_ID="${channelId}"`,
        `MATTERMOST_ROOT_POST_ID="${rootPostId}"`,
        "export MATTERMOST_CHANNEL_ID MATTERMOST_ROOT_POST_ID",
        "```",
        "Post intermediate text with POST /api/v4/posts:",
        "```bash",
        'MATTERMOST_MESSAGE="<message>"',
        "export MATTERMOST_MESSAGE",
        'PAYLOAD=$(node -e \'console.log(JSON.stringify({channel_id: process.env.MATTERMOST_CHANNEL_ID, root_id: process.env.MATTERMOST_ROOT_POST_ID, message: process.env.MATTERMOST_MESSAGE}))\')',
        "curl -sS -X POST \\",
        '  -H "Authorization: Bearer $MATTERMOST_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d "$PAYLOAD" \\',
        '  "$MATTERMOST_URL/api/v4/posts"',
        "```",
        "Upload a generated session artifact with POST /api/v4/files, then attach the returned file id to a thread post with file_ids:",
        "```bash",
        'ARTIFACT_PATH="<path under the current session/generated artifact directory>"',
        'MATTERMOST_MESSAGE="<message>"',
        "export MATTERMOST_MESSAGE",
        "UPLOAD_JSON=$(curl -sS -X POST \\",
        '  -H "Authorization: Bearer $MATTERMOST_TOKEN" \\',
        '  -F "channel_id=$MATTERMOST_CHANNEL_ID" \\',
        '  -F "files=@${ARTIFACT_PATH}" \\',
        '  "$MATTERMOST_URL/api/v4/files")',
        'FILE_ID=$(printf "%s" "$UPLOAD_JSON" | node -e \'let data = ""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const j = JSON.parse(data); process.stdout.write(j.file_infos?.[0]?.id || j.file_ids?.[0] || ""); });\')',
        "export FILE_ID",
        'PAYLOAD=$(node -e \'console.log(JSON.stringify({channel_id: process.env.MATTERMOST_CHANNEL_ID, root_id: process.env.MATTERMOST_ROOT_POST_ID, message: process.env.MATTERMOST_MESSAGE, file_ids: [process.env.FILE_ID]}))\')',
        "curl -sS -X POST \\",
        '  -H "Authorization: Bearer $MATTERMOST_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d "$PAYLOAD" \\',
        '  "$MATTERMOST_URL/api/v4/posts"',
        "```",
        "After direct Mattermost posts or uploads, the final FELIX_REPLY should be concise and mention what was posted. Do not duplicate large report or artifact content in the final reply.",
      ],
    };
  }

  async updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void> {
    if (input.status === "processing") {
      await this.addReaction({ event: input.event, emoji: "⏳" });
      return;
    }
    if (input.status === "replied") {
      await this.removeReaction({ event: input.event, emoji: "⏳" });
      return;
    }
    await this.removeReaction({ event: input.event, emoji: "⏳" });
  }

  async sendTyping(input: { event: UniversalEvent }): Promise<void> {
    const channelId = input.event.source_thread_ref.conversation_id;
    if (!channelId) return;
    try {
      const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/users/me/typing`;
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel_id: channelId,
          parent_id: input.event.source_thread_ref.root_message_id ?? "",
        }),
      });
    } catch {
      // typing indicator is best-effort
    }
  }

  async sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void> {
    const ref = input.event.source_thread_ref;
    await this.postMessage({
      channel_id: ref.conversation_id,
      root_id: ref.root_message_id ?? ref.thread_id,
      message: input.text,
    });
  }

  async sendUserMessage(input: {
    userId: string;
    text: string;
  }): Promise<SourceMessageAnchor | null> {
    const channelId = await this.resolveDirectChannel(input.userId);
    if (!channelId) {
      throw new Error(`Unable to resolve DM channel for ${input.userId}`);
    }
    const posted = await this.postMessage({ channel_id: channelId, message: input.text });
    if (!posted) return null;
    return {
      source: "mattermost",
      conversation_id: posted.channel_id,
      message_id: posted.post_id,
      thread_id: posted.post_id,
    };
  }

  private async addReaction(input: { event: UniversalEvent; emoji: string }): Promise<void> {
    if (!input.event.source_thread_ref.root_message_id && !input.event.sender.id) return;
    const postId = input.event.event_id;
    await this.writeReaction("POST", {
      postId,
      emoji: input.emoji,
    });
  }

  private async removeReaction(input: { event: UniversalEvent; emoji: string }): Promise<void> {
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
      is_image: Boolean(
        fileInfo?.mime_type?.startsWith("image/") ?? input.attachment.content_type?.startsWith("image/"),
      ),
    };
  }

  private async ensureBotIdentity(): Promise<MattermostIdentity | null> {
    if (this.botIdentity) return this.botIdentity;
    if (this.botIdentityPromise) return this.botIdentityPromise;
    this.botIdentityPromise = this.fetchBotIdentity().finally(() => {
      this.botIdentityPromise = undefined;
    });
    this.botIdentity = await this.botIdentityPromise;
    return this.botIdentity;
  }

  private async fetchBotIdentity(): Promise<MattermostIdentity | null> {
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/users/me`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
      },
    });
    if (!res.ok) {
      log.warn("mattermost.bot_identity_failed", { status: res.status });
      if (!this.cfg.MATTERMOST_BOT_USER_ID) {
        return null;
      }
      const fallbackMentionTokens = mattermostMentionTokens(
        this.cfg.MATTERMOST_BOT_USERNAME,
        this.cfg.MATTERMOST_BOT_DISPLAY,
      );
      return {
        userId: this.cfg.MATTERMOST_BOT_USER_ID,
        username: this.cfg.MATTERMOST_BOT_USERNAME,
        displayName: this.cfg.MATTERMOST_BOT_DISPLAY,
        mentionTokens:
          fallbackMentionTokens.length > 0 ? fallbackMentionTokens : [`@${this.cfg.MATTERMOST_BOT_USER_ID}`],
      };
    }
    const me = (await res.json()) as MattermostMe;
    const userId = normalizeMattermostName(me.id ?? this.cfg.MATTERMOST_BOT_USER_ID);
    if (!userId) {
      return null;
    }
    const username = normalizeMattermostName(me.username ?? this.cfg.MATTERMOST_BOT_USERNAME);
    const displayName = normalizeMattermostName(
      me.display_name ?? me.nickname ?? this.cfg.MATTERMOST_BOT_DISPLAY,
    );
    const mentionTokens = mattermostMentionTokens(username, displayName);
    if (mentionTokens.length === 0) {
      mentionTokens.push(`@${userId}`);
    }
    if (this.cfg.MATTERMOST_BOT_USER_ID && this.cfg.MATTERMOST_BOT_USER_ID !== userId) {
      log.warn("mattermost.bot_identity_mismatch", {
        configured_user_id: this.cfg.MATTERMOST_BOT_USER_ID,
        fetched_user_id: userId,
      });
    }
    this.cfg.MATTERMOST_BOT_USER_ID = userId;
    if (username) this.cfg.MATTERMOST_BOT_USERNAME = username;
    if (displayName) this.cfg.MATTERMOST_BOT_DISPLAY = displayName;
    return {
      userId,
      username,
      displayName,
      mentionTokens,
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
    const ownerDecision = await parseOwnerDecisionAsync(post.text, this.cfg);
    if (ownerDecision && this.ownerUserId === post.sender.id) {
      const target = {
        kind: "owner_message" as const,
        anchor: {
          source: "mattermost",
          conversation_id: post.source_thread_ref.conversation_id,
          message_id: post.source_thread_ref.root_message_id ?? post.source_thread_ref.message_id,
          thread_id: post.source_thread_ref.thread_id,
        },
      };
      // Only route as an owner decision if there's a pending permission to decide on.
      // Otherwise, treat as a normal chat message so it gets ⏳ and LLM processing.
      if (await engine.hasPendingPermission(target)) {
        await engine.handleOwnerDecision({
          mode: ownerDecision.mode,
          decidedBy: post.sender.id,
          target,
        });
        return;
      }
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

  private async writeReaction(
    method: "POST" | "DELETE",
    input: { postId: string; emoji: string },
  ): Promise<void> {
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

  private async fetchFileInfo(
    fileId: string,
  ): Promise<{ name?: string; mime_type?: string; size?: number } | null> {
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
    const visibility = isDirectMessageChannelType(channelType) ? "dm" : "channel";
    const rawTeamId = typeof data.team_id === "string" ? data.team_id : undefined;
    const teamId =
      (rawTeamId && rawTeamId.length > 0 ? rawTeamId : undefined) ??
      this.channelTeamIdCache.get(record.channel_id);
    if (teamId && !this.channelTeamCache.has(record.channel_id)) {
      const teamName = await this.resolveTeamName(teamId);
      this.channelTeamCache.set(record.channel_id, teamName);
    }
    const sender = {
      source: "mattermost",
      id: record.user_id,
      username: typeof data.sender_username === "string" ? data.sender_username : undefined,
      display: typeof data.sender_name === "string" ? data.sender_name : record.user_id,
    };
    const botIdentity = await this.ensureBotIdentity();
    const rootId = normalizeThreadRootId(record.root_id, record.id);
    const sourceThreadRef = mattermostSourceThreadRef(record.channel_id, rootId, record.id, record.user_id, teamId);
    return {
      source: "mattermost",
      event_id: record.id,
      thread_key: mattermostThreadKey(record.channel_id, rootId),
      received_at: new Date(record.create_at ?? Date.now()).toISOString(),
      visibility,
      mentions_bot: isMentioned(message, botIdentity?.mentionTokens),
      sender,
      text: message,
      attachments:
        record.file_ids?.map((fileId) => ({
          file_id: fileId,
          filename: fileId,
        })) ?? [],
      raw_path: "",
      source_thread_ref: sourceThreadRef,
    };
  }

  private async prefetchBotTeams(): Promise<void> {
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/users/me/teams`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}` },
    }).catch(() => null);
    if (!res?.ok) return;
    const teams = (await res.json()) as { id?: string; name?: string }[];
    for (const team of teams) {
      if (team.id && team.name) {
        this.teamNameCache.set(team.id, team.name);
      }
    }
    log.info("mattermost.teams_prefetched", { count: teams.length });
  }

  private async resolvePostTeamId(postId: string): Promise<string | undefined> {
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/posts/${encodeURIComponent(postId)}/info`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}` },
    }).catch(() => null);
    if (!res?.ok) return undefined;
    const info = (await res.json()) as { team_id?: string };
    return info.team_id && info.team_id.length > 0 ? info.team_id : undefined;
  }

  private async resolveTeamName(teamId: string): Promise<string | undefined> {
    const cached = this.teamNameCache.get(teamId);
    if (cached !== undefined) return cached;
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/teams/${encodeURIComponent(teamId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}` },
    }).catch(() => null);
    if (!res?.ok) {
      this.teamNameCache.set(teamId, undefined);
      return undefined;
    }
    const info = (await res.json()) as { name?: string };
    this.teamNameCache.set(teamId, info.name);
    return info.name;
  }

  private async resolveChannelType(channelId: string): Promise<string | undefined> {
    const cached = this.channelTypeCache.get(channelId);
    if (cached !== undefined) return cached;
    const url = `${this.cfg.MATTERMOST_URL?.replace(/\/$/, "")}/api/v4/channels/${encodeURIComponent(channelId)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.cfg.MATTERMOST_TOKEN}`,
      },
    }).catch(() => null);
    if (!res?.ok) {
      this.channelTypeCache.set(channelId, undefined);
      return undefined;
    }
    const info = (await res.json()) as ChannelInfo;
    this.channelTypeCache.set(channelId, info.type);
    if (info.team_id && info.team_id.length > 0) {
      this.channelTeamIdCache.set(channelId, info.team_id);
    }
    return info.type;
  }
}

export function mattermostThreadKey(channelId: string, rootPostId: string): string {
  return `mattermost:${channelId}:${rootPostId}`;
}

export function mattermostSourceThreadRef(
  channelId: string,
  rootPostId: string,
  messageId: string,
  userId?: string,
  teamId?: string,
): SourceThreadRef {
  return {
    source: "mattermost",
    conversation_id: channelId,
    thread_id: rootPostId,
    root_message_id: rootPostId,
    message_id: messageId,
    team_id: teamId,
    raw: {
      channel_id: channelId,
      root_id: rootPostId,
      user_id: userId,
    },
  };
}

function normalizeThreadRootId(rootId: string | undefined, fallbackId: string): string {
  const trimmed = rootId?.trim();
  return trimmed ? trimmed : fallbackId;
}

function isMentioned(text: string, mentionTokens?: string[]): boolean {
  if (!mentionTokens || mentionTokens.length === 0) return false;
  return mentionTokens.some((token) => text.includes(token));
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

function isSelfMessage(senderId: string, botUserId: string): boolean {
  return senderId === botUserId || senderId.endsWith(`:${botUserId}`);
}

export function buildThreadLink(baseUrl: string, postId: string, teamName?: string): string {
  const url = baseUrl.replace(/\/$/, "");
  const encodedPostId = encodeURIComponent(postId);
  return teamName ? `${url}/${teamName}/pl/${encodedPostId}` : `${url}/_redirect/pl/${encodedPostId}`;
}

export function isDirectMessageChannelType(channelType?: string): boolean {
  return channelType === "D";
}
