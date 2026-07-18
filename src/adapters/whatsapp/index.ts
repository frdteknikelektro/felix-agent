import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type http from "node:http";
import type { AppConfig } from "../../config.js";
import { writeTextAtomic, ensureDir, safeFileName, readText } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import type { SourceAdapter, SourceEventStatus, SourceTurnContext } from "../../core/ports.js";
import type { FelixEngine } from "../../engine.js";
import { handleSourceEventIntake, handleSourceReactionIntake } from "../../core/source-intake.js";
import { isOwnerDecisionReactionToken } from "../../slices/approvals/index.js";
import { decisionEmoji, decisionLabel } from "../../core/decision.js";
import type { SourceMessageAnchor, SourceThreadRef, UniversalAttachment, UniversalEvent } from "../../types.js";
import { createSourceHost } from "../../core/source-host.js";
import type { PlatformIdentity } from "../../core/platform-identity.js";
import { readRequestBody } from "../../server/request-body.js";
import {
  AttachmentRejectedError,
  formatBytes,
  storedAttachmentPath,
} from "../../core/attachments.js";
import {
  normalizeSourceEvent,
  sourceThreadKey,
  sourceThreadRef,
} from "../../core/source-event-normalization.js";
import {
  findThreadHandle,
  loadSessionState,
  retargetThreadKey,
} from "../../slices/sessions/index.js";

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
const webhookSecrets = new WeakMap<AppConfig, string>();
let ownerSharesNumber = true;
let botJid: string | undefined;
let lastSendAt = 0;
// Typing presence is per-conversation: a typing indicator in one chat must not
// suppress one in another. Sends stay globally rate-limited (see lastSendAt).
const lastTypingAtByChat = new Map<string, number>();
const WHATSAPP_OUTBOUND_MIN_GAP_MS = 6000;

// Webhook intake is module-level (registered by app.ts), so its dedup lives here
// alongside the other module-level webhook state rather than on the adapter
// instance. wacli posts each message once, but a retried webhook delivery would
// otherwise be re-ingested; firstSight() drops the redelivery before persistence.
const webhookDedup = createSourceHost({ source: "whatsapp" });

// Serializes ensureCanonicalWhatsAppThread per old thread key so two concurrent
// fire-and-forget webhook dispatches for the same @lid chat cannot both retarget.
const retargetsInFlight = new Set<string>();

// The expired-bot-message sweep is a directory scan; throttle it so it runs at
// most once per minute rather than on every inbound webhook.
let lastBotMessageCleanupAt = 0;
const BOT_MSG_CLEANUP_INTERVAL_MS = 60_000;

function getWebhookSecret(cfg: AppConfig): string {
  const existing = webhookSecrets.get(cfg);
  if (existing) return existing;
  const secret = cfg.WHATSAPP_WEBHOOK_SECRET || crypto.randomBytes(32).toString("hex");
  webhookSecrets.set(cfg, secret);
  return secret;
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
  if (elapsed < WHATSAPP_OUTBOUND_MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, WHATSAPP_OUTBOUND_MIN_GAP_MS - elapsed));
  }
  lastSendAt = Date.now();
}

interface WhatsAppResolveMeta {
  originalChatJid: string;
  resolvedChatJid?: string;
  originalSenderJid?: string;
  resolvedSenderJid?: string;
}

interface WacliMessageShowData {
  ChatJID?: string;
  MsgID?: string;
  SenderJID?: string;
  SenderName?: string;
  Timestamp?: string;
  Text?: string;
  MediaType?: string;
  MediaCaption?: string;
  Filename?: string;
  MimeType?: string;
  LocalPath?: string;
}

interface WacliMessageShowResponse {
  success?: boolean;
  data?: WacliMessageShowData | null;
  error?: string | null;
}

async function resolveWacliWebhookMessage(
  cfg: AppConfig,
  payload: ParsedMessage,
): Promise<{ payload: ParsedMessage; meta: WhatsAppResolveMeta }> {
  const originalChatJid = payload.Chat ?? "";
  const originalSenderJid = payload.SenderJID;
  const meta: WhatsAppResolveMeta = { originalChatJid, originalSenderJid };
  if (!originalChatJid || !payload.ID) return { payload, meta };

  const result = spawnSync(cfg.WHATSAPP_WACLI_BIN, [
    "messages", "show",
    "--chat", originalChatJid,
    "--id", payload.ID,
    "--json",
  ], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    log.warn("whatsapp.message_resolve_failed", {
      chat_jid: originalChatJid,
      msg_id: payload.ID,
      error: result.error?.message ?? (result.stderr?.trim() || `exit ${result.status}`),
    });
    return { payload, meta };
  }

  let parsed: WacliMessageShowResponse;
  try {
    parsed = JSON.parse(result.stdout || "{}") as WacliMessageShowResponse;
  } catch (error) {
    log.warn("whatsapp.message_resolve_failed", {
      chat_jid: originalChatJid,
      msg_id: payload.ID,
      error: error instanceof Error ? error.message : String(error),
    });
    return { payload, meta };
  }

  const data = parsed.data;
  if (!parsed.success || !data || data.MsgID !== payload.ID) {
    log.warn("whatsapp.message_resolve_failed", {
      chat_jid: originalChatJid,
      msg_id: payload.ID,
      error: parsed.error ?? "message show returned no matching message",
    });
    return { payload, meta };
  }

  const resolved = enrichParsedMessageFromWacli(payload, data);
  meta.resolvedChatJid = resolved.Chat;
  meta.resolvedSenderJid = resolved.SenderJID;
  return { payload: resolved, meta };
}

// Looks up a message's media location via `messages show`. Unlike `media
// download`, the `show` query is LID-tolerant — it resolves the supplied chat
// JID in both directions and returns the canonical (phone-number) ChatJID the
// store actually keys media under, plus the LocalPath that `sync
// --download-media` recorded once the background download completed.
function resolveWacliMediaLocation(
  cfg: AppConfig,
  chatJid: string,
  msgId: string,
): { canonicalChatJid: string; localPath: string } {
  const fallback = { canonicalChatJid: chatJid, localPath: "" };
  if (!chatJid || !msgId) return fallback;

  const result = spawnSync(cfg.WHATSAPP_WACLI_BIN, [
    "messages", "show",
    "--chat", chatJid,
    "--id", msgId,
    "--json",
  ], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Trust a complete, well-formed payload over the exit status: wacli can emit
  // valid JSON to stdout and then exit non-zero (or be signal-killed during
  // teardown). The success/MsgID checks below already reject truncated or error
  // output, so judging by the parsed body — not the exit code — keeps a good
  // lookup from being thrown away by a crash that happened after the answer.
  let parsed: WacliMessageShowResponse;
  try {
    parsed = JSON.parse(result.stdout || "{}") as WacliMessageShowResponse;
  } catch {
    return fallback;
  }

  const data = parsed.data;
  if (!parsed.success || !data || data.MsgID !== msgId) return fallback;

  return {
    canonicalChatJid: nonEmpty(data.ChatJID) ?? chatJid,
    localPath: nonEmpty(data.LocalPath) ?? "",
  };
}

function enrichParsedMessageFromWacli(payload: ParsedMessage, data: WacliMessageShowData): ParsedMessage {
  const originalChatJid = payload.Chat ?? "";
  const resolvedChatJid = nonEmpty(data.ChatJID);
  const chatJid = resolvedChatJid && canReplaceChatJid(originalChatJid, resolvedChatJid)
    ? resolvedChatJid
    : originalChatJid;
  const media = data.MediaType || data.MediaCaption || data.Filename || data.MimeType
    ? {
        ...(payload.Media ?? {}),
        Type: nonEmpty(data.MediaType) ?? payload.Media?.Type,
        Caption: nonEmpty(data.MediaCaption) ?? payload.Media?.Caption,
        Filename: nonEmpty(data.Filename) ?? payload.Media?.Filename,
        MimeType: nonEmpty(data.MimeType) ?? payload.Media?.MimeType,
      }
    : payload.Media;

  return {
    ...payload,
    Chat: chatJid,
    SenderJID: nonEmpty(data.SenderJID) ?? payload.SenderJID,
    PushName: nonEmpty(data.SenderName) ?? payload.PushName,
    Timestamp: nonEmpty(data.Timestamp) ?? payload.Timestamp,
    Text: nonEmpty(data.Text) ?? payload.Text,
    Media: media,
  };
}

function canReplaceChatJid(original: string, resolved: string): boolean {
  if (!original || !resolved) return false;
  if (isWhatsAppGroupJid(original)) return isWhatsAppGroupJid(resolved);
  return !isWhatsAppGroupJid(resolved);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// ─── Reply-to-Felix detection ─────────────────────────────────────────────────

export interface ReplyTargetInfo {
  senderJid: string;
  text: string;
  mediaCaption: string;
}

function fetchReplyTarget(
  cfg: AppConfig,
  chatJid: string,
  replyToId: string,
): ReplyTargetInfo | null {
  const result = spawnSync(cfg.WHATSAPP_WACLI_BIN, [
    "messages", "show",
    "--chat", chatJid,
    "--id", replyToId,
    "--json",
  ], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;

  let parsed: WacliMessageShowResponse;
  try {
    parsed = JSON.parse(result.stdout || "{}") as WacliMessageShowResponse;
  } catch {
    return null;
  }

  const data = parsed.data;
  if (!parsed.success || !data || data.MsgID !== replyToId) return null;

  return {
    senderJid: data.SenderJID ?? "",
    text: data.Text ?? "",
    mediaCaption: data.MediaCaption ?? "",
  };
}

export function isFelixMessage(
  target: ReplyTargetInfo,
  botName: string,
): boolean {
  // Dedicated number mode: SenderJID matches the bot's own JID
  // In shared-number mode, the owner and bot deliberately have the same JID,
  // so sender identity alone cannot prove that the quoted message was Felix's.
  if (!ownerSharesNumber && botJid && target.senderJid === botJid) return true;

  // Shared number mode: text or caption starts with *[BotName]*
  const prefix = `*[${botName}]*`;
  if (target.text.startsWith(prefix)) return true;
  if (target.mediaCaption.startsWith(prefix)) return true;

  return false;
}

// ─── Tracked owner-decision dispatch ──────────────────────────────────────────
//
// WhatsApp has no native link from a reply/reaction back to the bot's original
// permission message, so the adapter tracks bot messages on disk and resolves an
// Owner decision against them. A reply and a reaction can each arrive either as a
// FromMe event (owner shares the bot's number) or from a separate owner number;
// these dispatch tails are the single home for "tracked bot message → owner
// decision → clear tracking" so the four webhook call-sites cannot drift.

function ownerDecisionAnchor(cfg: AppConfig, msgId: string): SourceMessageAnchor {
  return {
    source: "whatsapp",
    conversation_id: cfg.WHATSAPP_OWNER_JID ?? "",
    message_id: msgId,
    thread_id: msgId,
  };
}

// Shared tail for both owner-decision dispatch paths: once the decision intake
// (with its path-specific not-found logging) settles, clear the tracked bot
// message and swallow any async error. The single home for cleanup + error logging.
function finishTrackedOwnerDecision(cfg: AppConfig, trackedMsgId: string, settled: Promise<unknown>): void {
  void settled
    .then(() => removeTrackedBotMessage(cfg, trackedMsgId))
    .catch((error) => {
      log.warn("whatsapp.webhook_async_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function dispatchTrackedOwnerReaction(
  cfg: AppConfig,
  engine: FelixEngine,
  args: { reactionTarget: string; emoji: string; msgId: string; decidedBy: string },
): void {
  const anchor = ownerDecisionAnchor(cfg, args.msgId);
  const settled = handleSourceReactionIntake(cfg, {
    source: "whatsapp",
    token: args.emoji,
    decidedBy: args.decidedBy,
    anchor,
    ports: engine,
  }).then((result) => {
    if (result.kind === "no_pending_approval") {
      log.warn("whatsapp.owner_decision_thread_not_found", {
        reaction_target: args.reactionTarget.slice(0, 40),
        message_id: args.msgId,
        target_anchor: { source: anchor.source, message_id: anchor.message_id },
      });
    }
  });
  finishTrackedOwnerDecision(cfg, args.reactionTarget, settled);
}

function dispatchTrackedOwnerReply(
  cfg: AppConfig,
  engine: FelixEngine,
  args: { replyTarget: string; event: UniversalEvent; msgId: string; decidedBy: string },
): void {
  // An owner reply to a tracked permission message is a decision, resolved by the
  // owner-message anchor — not a normal conversation message. It must NOT retarget
  // the thread key: doing so before the decision intake can move the session out
  // from under the pending-approval lookup. Thread canonicalization happens on
  // normal messages via dispatchResolvedWhatsAppEvent, symmetric with the reaction path.
  const anchor = ownerDecisionAnchor(cfg, args.msgId);
  const settled = handleSourceEventIntake(cfg, {
    event: args.event,
    owner: { decidedBy: args.decidedBy, anchor },
    ports: engine,
  }).then((result) => {
    if (result.kind === "owner_non_decision" && result.route === "no_pending_approval") {
      log.warn("whatsapp.owner_decision_thread_not_found", {
        reply_target: args.replyTarget.slice(0, 40),
        message_id: args.msgId,
      });
    }
  });
  finishTrackedOwnerDecision(cfg, args.replyTarget, settled);
}

async function dispatchResolvedWhatsAppEvent(
  cfg: AppConfig,
  engine: FelixEngine,
  event: UniversalEvent,
): Promise<void> {
  await ensureCanonicalWhatsAppThread(cfg, event);
  await handleSourceEventIntake(cfg, {
    event,
    ports: engine,
  });
}

async function ensureCanonicalWhatsAppThread(cfg: AppConfig, event: UniversalEvent): Promise<void> {
  const raw = event.source_thread_ref.raw as Record<string, unknown> | undefined;
  const originalChatJid = typeof raw?.original_chat_jid === "string" ? raw.original_chat_jid : undefined;
  const resolvedChatJid = typeof raw?.resolved_chat_jid === "string" ? raw.resolved_chat_jid : undefined;
  if (!originalChatJid || !resolvedChatJid || originalChatJid === resolvedChatJid) return;

  const oldKey = whatsappThreadKey(originalChatJid);
  const canonicalKey = event.thread_key;
  if (oldKey === canonicalKey) return;

  // Serialize per old key: two concurrent fire-and-forget dispatches for the same
  // @lid chat must not both pass the check-then-act and double-retarget.
  if (retargetsInFlight.has(oldKey)) return;
  retargetsInFlight.add(oldKey);
  try {
    const [oldThread, canonicalThread] = await Promise.all([
      findThreadHandle(cfg, oldKey, "whatsapp"),
      findThreadHandle(cfg, canonicalKey, "whatsapp"),
    ]);
    if (!oldThread) return;
    if (canonicalThread) {
      log.warn("whatsapp.thread_alias_conflict", {
        old_thread_key: oldKey,
        canonical_thread_key: canonicalKey,
      });
      return;
    }

    // Never retarget a thread with an in-flight turn: the engine keys its
    // processing/cancellation maps by thread_key string, so renaming the key
    // mid-turn would orphan the running turn and let a second turn start on the
    // same session directory. Defer — a later idle message will migrate it.
    const session = await loadSessionState(oldThread);
    if (session.busy) {
      log.info("whatsapp.thread_retarget_deferred", {
        old_thread_key: oldKey,
        canonical_thread_key: canonicalKey,
      });
      return;
    }

    await retargetThreadKey(cfg, oldThread, {
      threadKey: canonicalKey,
      sourceThreadRef: event.source_thread_ref,
    });
    log.info("whatsapp.thread_retargeted", {
      old_thread_key: oldKey,
      canonical_thread_key: canonicalKey,
    });
  } finally {
    retargetsInFlight.delete(oldKey);
  }
}

export async function handleWhatsAppWebhook(
  cfg: AppConfig,
  engine: FelixEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readRequestBody(req);

  const signature = req.headers["x-wacli-signature"];
  if (typeof signature !== "string" || !verifyWebhookSignature(body, getWebhookSecret(cfg), signature)) {
    log.warn("whatsapp.webhook_invalid_signature");
    sendJson(res, 401, { error: "invalid_signature" });
    return;
  }

  const nowMs = Date.now();
  if (nowMs - lastBotMessageCleanupAt >= BOT_MSG_CLEANUP_INTERVAL_MS) {
    lastBotMessageCleanupAt = nowMs;
    await cleanupExpiredBotMessages(cfg);
  }

  const botName = cfg.FELIX_NAME;
  const botAliases = (cfg.WHATSAPP_BOT_ALIASES ?? "").split(",").map(a => a.trim()).filter(Boolean);

  let payload: ParsedMessage;
  try {
    payload = JSON.parse(body);
  } catch {
    log.warn("whatsapp.webhook_invalid_json");
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const originalChatJid = payload.Chat || "";
  let chatJid = originalChatJid;
  const messageId = payload.ID || "";
  if (!chatJid || !messageId) {
    sendJson(res, 200, { ignored: "missing_fields" });
    return;
  }

  if (chatJid.includes("@broadcast")) {
    sendJson(res, 200, { ignored: "broadcast_chat" });
    return;
  }

  // Cheap gates run BEFORE the blocking wacli resolution subprocess
  // (resolveWacliWebhookMessage spawns `wacli messages show` synchronously):
  //   - pre-connect history, judged on the raw webhook delivery Timestamp
  //     (resolution would overwrite it with the stored message timestamp);
  //   - duplicate redeliveries;
  //   - the bot's own prefixed messages (highest-volume FromMe traffic),
  //     recognised on the raw text which carries the prefix as sent.
  // None of these should pay for a subprocess spawn.
  if (wacliStartedAt !== null && payload.Timestamp) {
    const msgTs = Date.parse(payload.Timestamp);
    if (!Number.isNaN(msgTs) && msgTs < wacliStartedAt) {
      sendJson(res, 200, { ignored: "pre_connect_history" });
      return;
    }
  }

  if (!webhookDedup.firstSight(messageId)) {
    sendJson(res, 200, { ignored: "duplicate" });
    return;
  }

  if (payload.FromMe && (payload.Text ?? "").startsWith(`*[${botName}]*`)) {
    if (payload.Media) void deleteWacliMedia(getWacliStoreDir(), chatJid, payload.ID ?? "");
    sendJson(res, 200, { ignored: "self_message" });
    return;
  }

  const resolved = await resolveWacliWebhookMessage(cfg, payload);
  payload = resolved.payload;
  chatJid = payload.Chat || chatJid;

  if (payload.FromMe) {
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
        if (!emoji || !isOwnerDecisionReactionToken(emoji)) {
          sendJson(res, 200, { ignored: "unrecognized_emoji" });
          return;
        }
        sendJson(res, 200, { ok: true });
        dispatchTrackedOwnerReaction(cfg, engine, {
          reactionTarget,
          emoji,
          msgId: botMsg.msgId,
          decidedBy: payload.SenderJID ?? "unknown",
        });
        return;
      }
      log.info("whatsapp.reaction_untracked", { reaction_target: reactionTarget.slice(0, 40) });
      sendJson(res, 200, { ignored: "self_reaction" });
      return;
    }

    // ── Owner replying to a bot permission-request message ────────────
    if (payload.ReplyToID) {
      const replyTarget = payload.ReplyToID;
      if (await hasTrackedBotMessage(cfg, replyTarget)) {
        const botMsg = await getTrackedBotMessage(cfg, replyTarget);
        if (!botMsg) {
          sendJson(res, 200, { ignored: "self_reaction" });
          return;
        }
        const event = normalizeParsedMessage(payload, botName, botAliases, resolved.meta, ownerSharesNumber);
        if (!event) {
          sendJson(res, 200, { ignored: "empty_event" });
          return;
        }
        sendJson(res, 200, { ok: true });
        dispatchTrackedOwnerReply(cfg, engine, {
          replyTarget,
          event,
          msgId: botMsg.msgId,
          decidedBy: payload.SenderJID ?? "unknown",
        });
        return;
      }
      log.info("whatsapp.reply_untracked", { reply_target: replyTarget.slice(0, 40) });
    }

    // ── Reply-to-Felix detection (shared number) ─────────────────────
    let replyToBot = false;
    if (payload.ReplyToID && ownerSharesNumber) {
      const target = fetchReplyTarget(cfg, chatJid, payload.ReplyToID);
      if (target && isFelixMessage(target, botName)) {
        replyToBot = true;
      }
    }

    // ── Owner using the same number ──────────────────────────────────
    if (ownerSharesNumber) {
      // Media-only self-message (no text/caption) — bot's own outgoing file
      const mediaText = nonEmpty(payload.Text) ?? nonEmpty(payload.Media?.Caption) ?? "";
      if (payload.Media && !mediaText.trim()) {
        void deleteWacliMedia(getWacliStoreDir(), chatJid, payload.ID ?? "");
        sendJson(res, 200, { ignored: "self_media" });
        return;
      }
      const event = normalizeParsedMessage(payload, botName, botAliases, resolved.meta, ownerSharesNumber);
      if (!event) {
        sendJson(res, 200, { ignored: "empty_event" });
        return;
      }
      // If replying to a Felix message, treat as if mentioned
      if (replyToBot) {
        event.mentions_bot = true;
      }
      // Shared number: owner and bot share the same JID. Use a distinct
      // sender ID so isOwnMessage doesn't drop owner messages from queue.
      event.sender.id = `owner:${event.sender.id}`;
      // Clean up media for group messages Felix won't process
      const isGroup = isWhatsAppGroupJid(chatJid);
      if (payload.Media && !replyToBot && isGroup) {
        void deleteWacliMedia(getWacliStoreDir(), chatJid, payload.ID ?? "");
      }
      sendJson(res, 200, { ok: true });
      void dispatchResolvedWhatsAppEvent(cfg, engine, event).catch((error) => {
        log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }

    // ── FromMe from a different number → ignore ─────────────────────
    if (payload.Media) void deleteWacliMedia(getWacliStoreDir(), chatJid, payload.ID ?? "");
    sendJson(res, 200, { ignored: "from_me" });
    return;
  }

  // ── Normal processing (incoming messages from others) ────────────────
  // If this is a reply to a tracked bot message, check for owner decision first
  if (payload.ReplyToID && await hasTrackedBotMessage(cfg, payload.ReplyToID)
      && cfg.WHATSAPP_OWNER_JID && payload.SenderJID === cfg.WHATSAPP_OWNER_JID) {
    const replyTarget = payload.ReplyToID;
    const event = normalizeParsedMessage(payload, botName, botAliases, resolved.meta, ownerSharesNumber);
    if (!event) {
      sendJson(res, 200, { ignored: "empty_event" });
      return;
    }
    sendJson(res, 200, { ok: true });
    const botMsg = await getTrackedBotMessage(cfg, replyTarget);
    if (!botMsg) return;
    dispatchTrackedOwnerReply(cfg, engine, {
      replyTarget,
      event,
      msgId: botMsg.msgId,
      decidedBy: payload.SenderJID ?? "unknown",
    });
    return;
  }

  // If this is a reaction on a tracked bot message from the owner
  if (payload.ReactionToID && await hasTrackedBotMessage(cfg, payload.ReactionToID)
      && cfg.WHATSAPP_OWNER_JID && payload.SenderJID === cfg.WHATSAPP_OWNER_JID) {
    const reactionTarget = payload.ReactionToID;
    const emoji = payload.ReactionEmoji ?? "";
    if (!emoji || !isOwnerDecisionReactionToken(emoji)) {
      sendJson(res, 200, { ignored: "unrecognized_emoji" });
      return;
    }
    const botMsg = await getTrackedBotMessage(cfg, reactionTarget);
    if (!botMsg) {
      sendJson(res, 200, { ignored: "tracked_message_missing" });
      return;
    }
    sendJson(res, 200, { ok: true });
    dispatchTrackedOwnerReaction(cfg, engine, {
      reactionTarget,
      emoji,
      msgId: botMsg.msgId,
      decidedBy: payload.SenderJID ?? "unknown",
    });
    return;
  }

  // ── Reply-to-Felix detection (non-FromMe) ──────────────────────────
  let replyToBot = false;
  if (payload.ReplyToID && !payload.FromMe) {
    if (!ownerSharesNumber) {
      // Dedicated number: any reply to a bot message triggers
      const target = fetchReplyTarget(cfg, chatJid, payload.ReplyToID);
      if (target && botJid && target.senderJid === botJid) {
        replyToBot = true;
      }
    } else {
      // Shared number: only trigger if Felix prefix is present
      const target = fetchReplyTarget(cfg, chatJid, payload.ReplyToID);
      if (target && isFelixMessage(target, botName)) {
        replyToBot = true;
      }
    }
  }

  const event = normalizeParsedMessage(payload, botName, botAliases, resolved.meta, ownerSharesNumber);
  if (!event) {
    sendJson(res, 200, { ignored: "empty_event" });
    return;
  }

  // If replying to a Felix message, treat as if mentioned
  if (replyToBot) {
    event.mentions_bot = true;
  }

  sendJson(res, 200, { ok: true });

  // Delete media for messages Felix won't use (not mentioned, not DM)
  const isGroup = isWhatsAppGroupJid(chatJid);
  const isMentioned = event.mentions_bot;
  const isDM = !isGroup;
  if (payload.Media && !isMentioned && !isDM) {
    void deleteWacliMedia(getWacliStoreDir(), chatJid, payload.ID ?? "");
  }

  void dispatchResolvedWhatsAppEvent(cfg, engine, event).catch((error) => {
    log.warn("whatsapp.webhook_async_error", { error: error instanceof Error ? error.message : String(error) });
  });
}

// ─── Media cleanup ─────────────────────────────────────────────────────────────

async function deleteWacliMedia(storeDir: string, chatJid: string, msgId: string): Promise<void> {
  const mediaDir = path.join(storeDir, "media", chatJid, msgId);
  try {
    await fs.rm(mediaDir, { recursive: true, force: true });
  } catch {
    // best-effort — directory may not exist
  }
}

function getWacliStoreDir(): string {
  const custom = process.env.WACLI_STORE_DIR;
  if (custom) return custom;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".local", "state", "wacli");
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
  get botIdentity(): PlatformIdentity | undefined {
    if (!this.botJid) return undefined;
    return {
      ...platformIdentityFromWacliAuth({ jid: this.botJid, connected: true }),
      displayName: this.cfg.FELIX_NAME,
    };
  }
  get botUserId(): string | undefined {
    return this.botJid;
  }
  get ownerUserId(): string | undefined {
    return this.cfg.WHATSAPP_OWNER_JID;
  }
  get ownerDisplay(): string {
    return this.cfg.WHATSAPP_OWNER_DISPLAY || "Owner";
  }
  private process?: ReturnType<typeof spawn>;
  private sameNumber = false;
  private botJid?: string;
  private typingInFlight = false;
  private readonly host = createSourceHost({ source: "whatsapp" });

  constructor(private readonly cfg: AppConfig) {}

  // ── start (supervisor contract) ──────────────────────────────────────────

  async start(engine: FelixEngine): Promise<{ stop(): void; done: Promise<void> }> {
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
    botJid = authOk.jid;

    const secret = getWebhookSecret(this.cfg);

    const port = 3000;
    const args = [
      "sync", "--follow",
      "--download-media",
      "--webhook", `http://127.0.0.1:${port}/webhooks/whatsapp`,
      "--webhook-secret", secret,
      "--webhook-allow-private",
      "--max-reconnect", "0",
    ];

    return this.host.run({
      source: "whatsapp",
      connect: async () => {
        log.info("whatsapp.starting", { webhook_port: port });
        this.process = spawn(this.cfg.WHATSAPP_WACLI_BIN, args, {
          stdio: ["ignore", "inherit", "inherit"],
          env: {
            ...process.env,
            PATH: process.env.PATH ?? "",
          },
        });
        wacliStartedAt = Date.now();

        this.process!.on("error", (err) => {
          log.warn("whatsapp.process_error", { error: err.message });
        });

        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        this.process!.on("exit", (code) => {
          log.info("whatsapp.process_exit", { code });
          wacliStartedAt = null;
          resolveClosed();
        });

        return {
          disconnect: () => {
            this.process!.kill("SIGTERM");
            wacliStartedAt = null;
          },
          closed,
        };
      },
    });
  }

  // ── SourceAdapter implementation ─────────────────────────────────────────

  async getThreadLink(_threadKey: string): Promise<string | undefined> {
    return undefined;
  }

  async getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext> {
    const chatJid = input.event.source_thread_ref.conversation_id; // equals thread_key suffix
    const botName = this.cfg.FELIX_NAME;
    const aliases = (this.cfg.WHATSAPP_BOT_ALIASES ?? "").split(",").map(a => a.trim()).filter(Boolean);
    const mentionHow = aliases.length > 0
      ? `(e.g. \`@${botName}\`, or \`@${aliases.join("`, `@")}\`)`
      : `(e.g. \`@${botName}\`)`;
    // Only prefix messages when the bot shares a number with its owner — on a
    // dedicated number the sender already identifies the bot. The adapter's
    // own send paths (sendThreadReply / sendUserMessage) prepend the prefix
    // for outgoing replies; the LLM just replies like any other channel.
    // The caption template below bakes the prefix in so file uploads carry
    // it even when sent via `wacli send file`.
    const prefix = this.sameNumber ? `*[${botName}]*\n` : "";
    const ownerJid = this.cfg.WHATSAPP_OWNER_JID;
    const ownerMentionInstruction =
      ownerJid && !this.sameNumber
        ? `W7. Exception to the mention-target rule above: if you emit PERMISSION_REQUIRED, you MUST also call \`wacli send text --to "${chatJid}" --message "@${ownerJid.split("@")[0]} approval needed" --mention "${ownerJid}"\` to notify the owner — this is the one case where mentioning the owner JID is expected and required. Do not use this for any other purpose.`
        : undefined;
    const isOwner = ownerJid !== undefined && ownerJid === input.event.sender.id;

    return {
      isOwner,
      owner: {
        displayName: this.cfg.WHATSAPP_OWNER_DISPLAY || "Owner",
        userId: ownerJid,
      },
      behaviorInstructions: [
        `W1. Answer when @mentioned by name ${mentionHow} or when a user replies directly to one of your messages. If neither condition is met, output nothing — no FELIX_REPLY, no explanation.`,
        "W2. Fetch WhatsApp chat context if needed before answering:",
        "```bash",
        `wacli messages list --chat "${chatJid}" --limit 100 --json`,
        "```",
        "Use the official wacli command reference at https://wacli.sh/ or `wacli --help` when you need flags or subcommands not shown in these instructions.",
        "The JSON output has a `.data` array. Each entry has `.msg_id`, `.sender_jid`, `.sender_name`, `.ts` (Unix seconds), `.from_me` (bool), `.text`, `.display_text` (includes reply context), `.quoted_msg_id`, `.media_type`, and `.media_caption`. Sort by `.ts` to reconstruct the timeline.",
        "If the fetch fails, do not claim you read live WhatsApp history. Reply that the history could not be fetched and ask for a retry. Do not use the local thread transcript as a substitute for live WhatsApp history.",
        "W3. WhatsApp formatting: use *bold*, _italic_, ~strikethrough~, ``` `code` ```. Do NOT use Markdown — WhatsApp renders its own formatting natively. Format URLs as plain text — WhatsApp auto-preview links.",
        "W3.1. WhatsApp has NO table support. NEVER output pipe tables (`|---|---|`) — they render as garbled text. For simple tabular data, use key-value pairs with bold labels (e.g., `*Name:* Alice\n*Role:* Admin`). For larger or complex tables, write the data to a `.csv` or `.md` file and send it as an attachment with `wacli send file`.",
        "W4. **CRITICAL: Do NOT call `wacli send text` for your final reply.** Always use the `FELIX_REPLY` block for your response — the harness will send it automatically. Calling `wacli send text` AND outputting `FELIX_REPLY` causes duplicate messages. You may only use `wacli send text` for intermediate/progress messages (e.g., \"Processing...\") before your final `FELIX_REPLY`.",
        "To reply to a specific message, add `--reply-to <quoted_msg_id>`. In group chats, also add `--reply-to-sender <sender_jid>` when the sender JID is known.",
        "When @mentioning someone in a WhatsApp group via wacli, never guess or synthesize the mention target from a display name, first name, phone-looking text, or memory. First fetch live group context with `wacli messages list --json`, match the requested person to an exact `.sender_jid` from recent messages, and pass that exact JID to `--mention`. If no exact or unambiguous sender JID is available, ask the user for the person's phone/JID instead of mentioning the wrong account. Never use the group JID, bot JID, or owner JID as the mention target unless that exact account is explicitly requested.",
        "Upload a file:",
        "```bash",
        `wacli send file --to "${chatJid}" \\`,
        '  --file "<path under session artifact directory>" \\',
        `  --caption "${prefix}<optional caption>"`,
        "```",
        "W5. When a user sends media (image, document, or other attachment), it is downloaded to the session attachments directory and listed with its local path and MIME type in the turn prompt. For images (MIME `image/*`), open the file directly with your file-reading tool to actually SEE its visual content before answering — do NOT describe an image from metadata alone. Use `identify <path>` / `exiftool <path>` only for supplementary metadata (dimensions, EXIF). For other files use `file <path>` to identify the type and `bat --style=plain <path>` / `head -c 2000 <path>` for text-based inspection. Do NOT try to open binary files in a text editor.",
        "W6. Keep WhatsApp replies concise (≤ 500 characters preferred; WhatsApp's hard text limit is 65,536). WhatsApp is a mobile-first platform — long messages degrade readability. For longer outputs (code, logs, stack traces, large file contents), write the content to a file in the session attachments directory and use `wacli send file` to send it as an attachment instead of inlining it in the chat message.",
        ...(ownerMentionInstruction ? [ownerMentionInstruction] : []),
      ],
    };
  }

  async updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void> {
    const chatJid = input.event.source_thread_ref.conversation_id;
    if (!chatJid) return;
    const eventId = input.event.event_id;

    // "processing" → add ⏳; everything else → remove ⏳ (aligns with Discord/Slack/Mattermost)
    const reaction = input.status === "processing" ? "⏳" : "";
    // --sender is the JID of the person who sent the message being reacted to
    // (required for group reactions).
    const senderArgs = this.senderArgsForChat(chatJid, input.event.sender.id, "status");
    await waitForSendSlot();
    try {
      spawnSync(this.cfg.WHATSAPP_WACLI_BIN, [
        "send", "react",
        "--to", chatJid,
        "--id", eventId,
        "--reaction", reaction,
        "--post-send-wait", "0",
        ...senderArgs,
      ], { stdio: "ignore", timeout: 10_000 });
    } catch {
      // best-effort
    }
  }

  async sendTyping(input: { event: UniversalEvent }): Promise<void> {
    const chatJid = input.event.source_thread_ref.conversation_id;
    if (!chatJid || this.typingInFlight) return;
    const elapsed = Date.now() - (lastTypingAtByChat.get(chatJid) ?? 0);
    if (elapsed < WHATSAPP_OUTBOUND_MIN_GAP_MS) return;

    lastTypingAtByChat.set(chatJid, Date.now());
    this.typingInFlight = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const child = spawn(this.cfg.WHATSAPP_WACLI_BIN, [
        "presence", "typing",
        "--to", chatJid,
        "--lock-wait", "10s",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: process.env.PATH ?? "",
        },
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, 15_000);
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.typingInFlight = false;
        resolve();
      };
      child.on("error", done);
      child.on("close", (code) => {
        if (code !== 0) {
          log.warn("whatsapp.typing_failed", { chat_jid: chatJid, code });
        }
        done();
      });
    });
  }

  private async sendPaused(chatJid: string): Promise<void> {
    try {
      spawnSync(this.cfg.WHATSAPP_WACLI_BIN, [
        "presence", "paused",
        "--to", chatJid,
      ], { stdio: "ignore", timeout: 5_000 });
    } catch {
      // best-effort
    }
  }

  async sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void> {
    const chatJid = input.event.source_thread_ref.conversation_id;
    if (!chatJid) {
      throw new Error("WhatsApp sendThreadReply: missing conversation_id in source_thread_ref");
    }
    const isSystem = input.event.sender.id === "system" || input.event.sender.id.startsWith("owner:");
    const replyToMsgId = !isSystem ? input.event.event_id : undefined;
    const replyToSender = !isSystem ? input.event.sender.id.replace(/^owner:/, "") : undefined;
    const replyToArg = replyToMsgId && replyToSender
      ? ["--reply-to", replyToMsgId, "--reply-to-sender", replyToSender]
      : [];

    const botName = this.cfg.FELIX_NAME;
    const prefix = `*[${botName}]*`;
    const text = input.text.startsWith(prefix) ? input.text : `${prefix}\n${input.text}`;

    const args = [
      "send", "text",
      "--to", chatJid,
      "--message", text,
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
    await this.sendPaused(chatJid);
  }

  async sendUserMessage(input: {
    userId: string;
    text: string;
  }): Promise<SourceMessageAnchor | null> {
    const botName = this.cfg.FELIX_NAME;
    const prefix = `*[${botName}]*`;
    const text = input.text.startsWith(prefix) ? input.text : `${prefix}\n${input.text}`;

    const args = [
      "send", "text",
      "--to", input.userId,
      "--message", text,
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
      if (result.status !== 0) {
        log.warn("whatsapp.send_user_status", {
          chat_jid: input.userId,
          status: result.status,
          stderr: result.stderr?.slice(0, 500),
          stdout: result.stdout?.slice(0, 500),
        });
      } else if (result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          const inner = parsed.data ?? parsed;
          const msgId = inner.id;
          if (msgId) {
            const anchor: SourceMessageAnchor = {
              source: "whatsapp",
              conversation_id: input.userId,
              message_id: msgId,
              thread_id: msgId,
            };
            await addTrackedBotMessage(this.cfg, msgId, whatsappThreadKey(input.userId));
            return anchor;
          }
          log.warn("whatsapp.send_user_missing_id", { chat_jid: input.userId, parsed: result.stdout.slice(0, 500) });
        } catch {
          log.warn("whatsapp.send_user_parse", { chat_jid: input.userId, stdout: result.stdout?.slice(0, 200) });
        }
      } else {
        log.warn("whatsapp.send_user_empty", { chat_jid: input.userId, stderr: result.stderr?.slice(0, 500) });
      }
      return null;
    } catch (error) {
      throw new Error(`Unable to send WhatsApp DM to ${input.userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async editUserMessage(input: { anchor: SourceMessageAnchor; text: string }): Promise<void> {
    const chatJid = input.anchor.conversation_id;
    if (!chatJid) {
      throw new Error("WhatsApp editUserMessage: missing anchor fields");
    }
    // wacli messages edit can't run when sync holds the store — send a new
    // message instead (delegated through sync IPC). Only send the status
    // update; the owner already has the full notification.
    const statusMatch = input.text.match(/\*Status\*\n`(\w+)`/);
    const decisionMatch = input.text.match(/\*Decision\*\n(.+?)(?:\n|$)/);
    const status = statusMatch ? `*${statusMatch[1]}*` : "done";
    const decision = decisionMatch?.[1]?.trim();
    const text = decision ? `${status} — ${decision}` : status;
    await this.sendUserMessage({ userId: chatJid, text });
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
      `*Requester*\n${input.requesterName} (\`${input.requesterId}\`)`,
      `*Skill*\n\`${input.skillId}\``,
      `*Permissions*\n${input.permissions.map((p) => `\`${p}\``).join(", ")}`,
      `*Reason*\n${input.reason}`,
      `*Status*\n\`${status}\``,
    ];
    if (status !== "pending" && input.decisionMode) {
      lines.push(`*Decision*\n${decisionEmoji(input.decisionMode)} ${decisionLabel(input.decisionMode)}`);
    }
    if (input.decidedAt) {
      lines.push(`*Resolved*\n${input.decidedAt}`);
    }
    if (input.threadLink) {
      lines.push(`*Thread*\n${input.threadLink}`);
    }
    if (status === "pending") {
      lines.push(
        "Reply `yes` to approve once, `always` to always allow, or `no` to reject.",
        "You can also react with 👌 (once), 👍 (always), or 🙏 (reject).",
      );
    }
    return lines.join("\n\n");
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
    this.host.gateAttachment(input.attachment, input.maxBytes);

    const filename = input.attachment.filename ?? input.attachment.file_id;
    const dest = storedAttachmentPath(
      input.destinationDir,
      input.event.received_at,
      filename,
      input.attachment.file_id,
    );
    await ensureDir(path.dirname(dest));

    // `media download` keys media on the canonical phone-number JID and rejects
    // the LID/raw form a webhook may carry; `messages show` is LID-tolerant and
    // also surfaces the file `sync --download-media` already fetched. Prefer the
    // synced copy (no second server fetch) and fall back to a download against
    // the canonical JID.
    const { canonicalChatJid, localPath } = resolveWacliMediaLocation(
      this.cfg,
      chatJid,
      input.attachment.file_id,
    );

    let copiedFromStore = false;
    if (localPath) {
      try {
        await fs.copyFile(localPath, dest);
        copiedFromStore = true;
      } catch (error) {
        log.warn("whatsapp.media_store_copy_failed", {
          chat_jid: canonicalChatJid,
          msg_id: input.attachment.file_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!copiedFromStore) {
      const args = [
        "media", "download",
        "--chat", canonicalChatJid,
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
          // wacli can write the output file and still exit non-zero (or be
          // signal-killed during teardown). Treat a produced, non-empty file as
          // success — the size gate below validates it — and only fail when
          // nothing usable landed on disk.
          const wrote = await fs.stat(dest).then((s) => s.size > 0).catch(() => false);
          if (!wrote) {
            const err = result.stderr || result.error?.message || `exit ${result.status}`;
            throw new Error(`media download failed: ${String(err).trim()}`);
          }
          log.warn("whatsapp.media_download_nonzero_exit", {
            chat_jid: canonicalChatJid,
            msg_id: input.attachment.file_id,
            status: result.status,
            signal: result.signal,
          });
        }
      } catch (error) {
        log.warn("whatsapp.media_download_failed", {
          chat_jid: canonicalChatJid,
          msg_id: input.attachment.file_id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new AttachmentRejectedError(
          "Media download failed",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    }

    // The size gate above trusts the declared size; enforce the real limit on
    // the file actually written, whether copied from the store or downloaded.
    const stat = await fs.stat(dest);
    if (stat.size > input.maxBytes) {
      await fs.rm(dest, { force: true });
      throw new AttachmentRejectedError(
        `attachment exceeds ${formatBytes(input.maxBytes)}`,
        `File is ${formatBytes(stat.size)}, above the ${formatBytes(input.maxBytes)} limit.`,
      );
    }

    return {
      ...input.attachment,
      filename,
      size_bytes: stat.size,
      local_path: dest,
      status: "available",
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private senderArgsForChat(chatJid: string, rawSenderId: string, operation: string): string[] {
    const messageSenderJid = rawSenderId.replace(/^owner:/, "");
    if (messageSenderJid) return ["--sender", messageSenderJid];

    log.warn("whatsapp.sender_missing", { chat_jid: chatJid, operation });
    return [];
  }
}

// ─── Message normalization ────────────────────────────────────────────────────

function normalizeParsedMessage(
  pm: ParsedMessage,
  botName: string,
  aliases: string[] = [],
  resolveMeta?: WhatsAppResolveMeta,
  sameNumber = true,
): UniversalEvent | null {
  const chatJid = pm.Chat || "";
  if (!chatJid) return null;

  const text = pm.Text ?? pm.Media?.Caption ?? "";
  const mentionText = [pm.Text, pm.Media?.Caption].filter(Boolean).join("\n");
  const hasText = text.trim().length > 0;
  const hasMedia = Boolean(pm.Media);
  const hasReaction = Boolean(pm.ReactionToID);
  if (!hasText && !hasMedia && !hasReaction) return null;

  const isGroup = isWhatsAppGroupJid(chatJid);
  const visibility = !sameNumber && !isGroup ? "dm" : "channel";
  const senderJid = pm.SenderJID ?? "unknown";
  const mentionsBot = detectsWhatsappMention(mentionText, botName, aliases);

  const displayText = hasReaction
    ? `[Reacted ${pm.ReactionEmoji ?? "👍"} to ${pm.ReactionToID}]`
    : text;

  const attachments: UniversalAttachment[] = pm.Media
    ? [{
        file_id: pm.ID ?? "",
        filename: pm.Media.Filename ?? pm.ID ?? "media",
        content_type: pm.Media.MimeType,
        size_bytes: pm.Media.FileLength,
        is_image: pm.Media.MimeType?.startsWith("image/") ? true : undefined,
      }]
    : [];

  return normalizeSourceEvent({
    source: "whatsapp",
    eventId: pm.ID ?? "",
    receivedAt: pm.Timestamp
      ? new Date(pm.Timestamp).toISOString()
      : new Date().toISOString(),
    visibility,
    mentionsBot,
    sender: {
      source: "whatsapp",
      id: senderJid,
      display: pm.PushName,
    },
    text: displayText,
    attachments,
    thread: {
      source: "whatsapp",
      conversationId: chatJid,
      rootMessageId: chatJid,
      messageId: pm.ID ?? "",
      raw: {
        chat_jid: chatJid,
        sender_jid: senderJid,
        ...(resolveMeta?.originalChatJid ? { original_chat_jid: resolveMeta.originalChatJid } : {}),
        ...(resolveMeta?.resolvedChatJid ? { resolved_chat_jid: resolveMeta.resolvedChatJid } : {}),
        ...(resolveMeta?.originalSenderJid ? { original_sender_jid: resolveMeta.originalSenderJid } : {}),
        ...(resolveMeta?.resolvedSenderJid ? { resolved_sender_jid: resolveMeta.resolvedSenderJid } : {}),
      },
    },
  });
}

// ─── Mention detection ────────────────────────────────────────────────────────

export function detectsWhatsappMention(text: string, botName: string, aliases: string[] = []): boolean {
  const lower = text.toLowerCase();
  if (containsStrictMention(lower, botName.toLowerCase())) return true;
  for (const alias of aliases) {
    const a = alias.trim().toLowerCase();
    if (a && containsStrictMention(lower, a)) return true;
  }
  return false;
}

function containsStrictMention(text: string, name: string): boolean {
  return new RegExp(`(?:^|(?<=\\s))@${name}(?!\\w)`).test(text);
}

export function isWhatsAppGroupJid(jid: string): boolean {
  return jid.includes("@g.us");
}

// ─── wacli helpers ────────────────────────────────────────────────────────────

export interface WacliAuthInfo {
  jid: string;
  connected: boolean;
}

function platformIdentityFromWacliAuth(info: WacliAuthInfo): PlatformIdentity {
  return {
    userId: info.jid,
    displayName: undefined,
    source: "paired-account",
    discovered: true,
  };
}

export function discoverWhatsAppAuth(bin: string): WacliAuthInfo | null {
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

const checkWacliAuth = discoverWhatsAppAuth;

// ─── Webhook HMAC verification ────────────────────────────────────────────────

function verifyWebhookSignature(body: string, secret: string, signature: string): boolean {
  if (!/^sha256=[0-9a-fA-F]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(signature.slice("sha256=".length), "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
}

// ─── HTTP utils (for webhook handler, avoid coupling to app.ts) ───────────────

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export function whatsappThreadKey(chatJid: string): string {
  return sourceThreadKey("whatsapp", chatJid, chatJid);
}

export function whatsappSourceThreadRef(opts: {
  chatJid: string;
  rootMessageId: string;
  messageId: string;
  senderJid?: string;
}): SourceThreadRef {
  return sourceThreadRef({
    source: "whatsapp",
    conversationId: opts.chatJid,
    rootMessageId: opts.rootMessageId,
    messageId: opts.messageId,
    raw: {
      chat_jid: opts.chatJid,
      sender_jid: opts.senderJid,
    },
  });
}
