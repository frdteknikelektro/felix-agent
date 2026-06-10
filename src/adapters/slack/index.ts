import fs from "node:fs/promises";
import path from "node:path";
import { App } from "@slack/bolt";
import type { AppConfig } from "../../config.js";
import { writeTextAtomic, ensureDir } from "../../lib/fs.js";
import { fsTimestamp } from "../../lib/time.js";
import { log } from "../../lib/log.js";
import type { SourceAdapter, SourceEventStatus, SourceTurnContext } from "../../core/ports.js";
import type { FelixEngine } from "../../engine.js";
import { parseOwnerDecisionAsync } from "../../slices/approvals/index.js";
export { slackMentionToken } from "./mentions.js";
import type { SourceMessageAnchor, SourceThreadRef, UniversalAttachment, UniversalEvent } from "../../types.js";
import { sourceRawDir } from "../../workspace.js";

// ─── Public constructors ──────────────────────────────────────────────────────

export function createSlackAdapter(cfg: AppConfig): SourceAdapter {
  return new SlackAdapter(cfg);
}

export function startSlackSource(
  cfg: AppConfig,
  engine: FelixEngine,
  adapter?: SourceAdapter,
): Promise<{ stop(): void; done: Promise<void> }> {
  const a = (adapter ?? createSlackAdapter(cfg)) as SlackAdapter;
  return a.start(engine);
}

// ─── SlackAdapter ─────────────────────────────────────────────────────────────

const SKIP_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "message_replied",
  "thread_broadcast",
]);

class SlackAdapter implements SourceAdapter {
  source = "slack";
  get botUserId(): string | undefined {
    return this.cfg.SLACK_BOT_USER_ID;
  }
  get ownerUserId(): string | undefined {
    return this.cfg.SLACK_OWNER_USER_ID;
  }
  private app?: App;
  private workspaceUrl?: string;
  private discoveredBotUserId?: string;
  private seenMessages = new Map<string, number>();

  constructor(private readonly cfg: AppConfig) {}

  // ── start (supervisor contract) ──────────────────────────────────────────

  async start(engine: FelixEngine): Promise<{ stop(): void; done: Promise<void> }> {
    if (!this.cfg.SLACK_TOKEN || !this.cfg.SLACK_APP_TOKEN) {
      log.warn("slack.disabled", { reason: "missing_token" });
      return { stop: () => undefined, done: Promise.resolve() };
    }

    const app = new App({
      token: this.cfg.SLACK_TOKEN,
      socketMode: true,
      appToken: this.cfg.SLACK_APP_TOKEN,
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    app.event("message", async ({ event, client }) => {
      try {
        const subtype = (event as any).subtype as string | undefined;
        if (subtype && SKIP_SUBTYPES.has(subtype)) return;
        if ((event as any).bot_id) return;
        if (!(event as any).text && !(event as any).files?.length) return;
        await this.handleMessage(engine, event as any, client);
      } catch (error) {
        log.warn("slack.message_handler_error", { error: (error as Error).message });
      }
    });

    app.error(async (error) => {
      log.warn("slack.app_error", { error: error.message });
    });

    await app.start();

    try {
      const auth = await app.client.auth.test();
      this.workspaceUrl = (auth as any).url;
      this.discoveredBotUserId = (auth as any).user_id as string;
      log.info("slack.ready", {
        user_id: this.discoveredBotUserId,
        workspace: this.workspaceUrl,
      });
    } catch (error) {
      log.warn("slack.auth_test_failed", { error: (error as Error).message });
    }

    this.app = app;

    return {
      stop: async () => {
        await app.stop();
        resolveDone();
      },
      done,
    };
  }

  // ── SourceAdapter implementation ─────────────────────────────────────────

  async getThreadLink(threadKey: string): Promise<string | undefined> {
    const [source, channelId, rootId] = threadKey.split(":");
    if (source !== "slack") return undefined;
    const base = (this.workspaceUrl ?? "https://slack.com/").replace(/\/+$/, "");
    const ts = rootId.replace(/\./g, "");
    return `${base}/archives/${encodeURIComponent(channelId)}/p${ts}`;
  }

  async getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext> {
    const botId = this.cfg.SLACK_BOT_USER_ID ?? this.discoveredBotUserId ?? "unknown";
    const botMention = `<@${botId}>`;
    const rootMessageId =
      input.event.source_thread_ref.root_message_id ??
      input.event.source_thread_ref.thread_id ??
      input.event.event_id;
    const channelId = input.event.source_thread_ref.conversation_id;

    return {
      behaviorInstructions: [
        `9. For Slack channel messages (visibility: channel), only answer when the post explicitly mentions ${botMention}. If not mentioned, output nothing — no FELIX_REPLY, no explanation. In DMs (visibility: dm), answer normally regardless of mention.`,
        `10. For Slack threads, fetch the current message history before answering. Use a read-only shell script:`,
        "```bash",
        `CHANNEL_ID="${channelId}"`,
        `ROOT_TS="${rootMessageId}"`,
        'curl -sS -H "Authorization: Bearer $SLACK_TOKEN" \\',
        '  "https://slack.com/api/conversations.replies?channel=$CHANNEL_ID&ts=$ROOT_TS&limit=100"',
        "```",
        "Parse the JSON response: check ok=true, then read .messages[]. Each message has .text, .user, and .ts fields. The response includes the parent message and all thread replies.",
        "If the fetch fails, do not claim you read live Slack history. Reply that the history could not be fetched and ask for a retry. Do not use the local thread transcript as a substitute for live Slack history.",
        "11. Slack Source API posting: when a skill produces useful intermediate results, you may post them directly to the current Slack channel before the final FELIX_REPLY.",
        "Use the bot token for authorization (already in environment):",
        "```bash",
        `export CHANNEL_ID="${channelId}"`,
        "```",
        "Post text messages:",
        "```bash",
        'curl -sS -X POST \\',
        '  -H "Authorization: Bearer $SLACK_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d "{\\"channel\\":\\"$CHANNEL_ID\\",\\"text\\":\\"<message>\\"}" \\',
        '  "https://slack.com/api/chat.postMessage"',
        "```",
        "Upload files:",
        "```bash",
        "ARTIFACT_PATH=\"<path under session artifact directory>\"",
        'curl -sS -F "token=$SLACK_TOKEN" \\',
        '  -F "channels=$CHANNEL_ID" \\',
        '  -F "file=@${ARTIFACT_PATH}" \\',
        '  -F "title=<filename>" \\',
        '  "https://slack.com/api/files.upload"',
        "```",
        "After direct Slack posts or uploads, the final FELIX_REPLY should be concise and mention what was posted. Do not duplicate large report or artifact content in the final reply.",
      ],
    };
  }

  async updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void> {
    if (!this.app) return;
    const channelId = input.event.source_thread_ref.conversation_id;
    if (!channelId) return;
    const timestamp = input.event.event_id;
    try {
      if (input.status === "processing") {
        await this.app.client.reactions.add({
          channel: channelId,
          name: "hourglass_flowing_sand",
          timestamp,
        });
      } else {
        await this.app.client.reactions.remove({
          channel: channelId,
          name: "hourglass_flowing_sand",
          timestamp,
        });
      }
    } catch (error) {
      log.warn("slack.reaction_failed", {
        channel_id: channelId,
        timestamp,
        status: input.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async sendTyping(_input: { event: UniversalEvent }): Promise<void> {
    // Slack Web API does not expose a typing indicator endpoint
  }

  async sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void> {
    const channelId = input.event.source_thread_ref.conversation_id;
    if (!channelId) {
      throw new Error("Slack sendThreadReply: missing conversation_id in source_thread_ref");
    }
    if (!this.app) {
      throw new Error("Slack app not connected");
    }
    const rootMessageId = input.event.source_thread_ref.root_message_id;
    await this.app.client.chat.postMessage({
      channel: channelId,
      text: input.text,
      thread_ts: rootMessageId,
    });
  }

  async sendUserMessage(input: {
    userId: string;
    text: string;
  }): Promise<SourceMessageAnchor | null> {
    if (!this.app) return null;
    try {
      const result = await this.app.client.chat.postMessage({
        channel: input.userId,
        text: input.text,
      });
      if (!result.ok || !result.ts) return null;
      return {
        source: "slack",
        conversation_id: result.channel as string,
        message_id: result.ts as string,
        thread_id: result.ts as string,
      };
    } catch (error) {
      throw new Error(`Unable to send Slack DM to ${input.userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
  }): Promise<UniversalAttachment> {
    if (!this.app) {
      throw new Error("Slack downloadAttachment: app not connected");
    }
    const fileInfo = await this.app.client.files.info({
      file: input.attachment.file_id,
    });
    if (!fileInfo.ok || !fileInfo.file?.url_private) {
      throw new Error(`Cannot access Slack file ${input.attachment.file_id}`);
    }
    const url = fileInfo.file.url_private;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.cfg.SLACK_TOKEN}` },
    });
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

  private async handleMessage(
    engine: FelixEngine,
    event: Record<string, unknown>,
    _client: unknown,
  ): Promise<void> {
    const ts = event.ts as string;
    if (this.isDuplicate(ts)) return;
    this.remember(ts);

    const normalized = await this.normalizeSlackEvent(event);
    if (!normalized) return;

    await this.writeRawEvent(normalized);

    const ownerDecision = await parseOwnerDecisionAsync(normalized.text, this.cfg);
    if (ownerDecision && this.ownerUserId === normalized.sender.id) {
      const target = {
        kind: "owner_message" as const,
        anchor: {
          source: "slack",
          conversation_id: normalized.source_thread_ref.conversation_id,
          message_id: normalized.source_thread_ref.root_message_id ?? normalized.source_thread_ref.message_id,
          thread_id: normalized.source_thread_ref.thread_id,
        },
      };
      if (await engine.hasPendingPermission(target)) {
        await engine.handleOwnerDecision({
          mode: ownerDecision.mode,
          decidedBy: normalized.sender.id,
          target,
        });
        return;
      }
    }

    await engine.ingest(normalized);
  }

  private normalizeSlackEvent(event: Record<string, unknown>): UniversalEvent | null {
    const channelId = event.channel as string;
    const teamId = event.team as string | undefined;
    const userId = (event.user ?? (event.message as any)?.user) as string | undefined;

    const ts = event.ts as string;
    const threadTs = (event.thread_ts ?? (event as any).message?.thread_ts) as string | undefined;
    const rootMessageId = threadTs ?? ts;

    const isDM = channelId?.startsWith("D");
    const visibility = isDM ? "dm" : "channel";

    const botId = this.cfg.SLACK_BOT_USER_ID ?? this.discoveredBotUserId;
    const text = (event.text as string) ?? "";
    const mentionsBot = botId ? text.includes(`<@${botId}>`) : false;

    const files = (event.files as any[]) ?? [];
    const attachments: UniversalAttachment[] = files.map((f: any) => ({
      file_id: f.id as string,
      filename: (f.name ?? f.id) as string,
      content_type: f.mimetype as string | undefined,
      size_bytes: (f.size ?? 0) as number,
      is_image: (f.mimetype as string)?.startsWith("image/") ? true : undefined,
    }));

    const sourceThreadRef = slackSourceThreadRef({
      channelId,
      rootMessageId,
      messageId: ts,
      teamId,
      authorId: userId,
    });

    return {
      source: "slack",
      event_id: ts,
      thread_key: slackThreadKey(channelId, rootMessageId),
      received_at: new Date(parseFloat(ts) * 1000).toISOString(),
      visibility,
      mentions_bot: mentionsBot,
      sender: {
        source: "slack",
        id: userId ?? "unknown",
      },
      text,
      attachments,
      raw_path: "",
      source_thread_ref: sourceThreadRef,
    };
  }

  // ── Internal: raw event persistence ──────────────────────────────────────

  private async writeRawEvent(event: UniversalEvent): Promise<void> {
    await ensureDir(sourceRawDir(this.cfg.paths, "slack"));
    const file = path.join(
      sourceRawDir(this.cfg.paths, "slack"),
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
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export function slackThreadKey(channelId: string, rootMessageId: string): string {
  return `slack:${channelId}:${rootMessageId}`;
}

export function slackSourceThreadRef(opts: {
  channelId: string;
  rootMessageId: string;
  messageId: string;
  teamId?: string;
  authorId?: string;
}): SourceThreadRef {
  return {
    source: "slack",
    conversation_id: opts.channelId,
    thread_id: opts.rootMessageId,
    root_message_id: opts.rootMessageId,
    message_id: opts.messageId,
    raw: {
      channel_id: opts.channelId,
      root_id: opts.rootMessageId,
      team_id: opts.teamId,
      user_id: opts.authorId,
    },
  };
}

// ─── Internal utilities ──────────────────────────────────────────────────────

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
