import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { loadContact, upsertContact } from "./contacts.js";
import { hasRenderableOutput, parseAgentOutput, runCodexTurn, type PermissionRequiredOutput } from "./codex.js";
import { log } from "./lib/log.js";
import { appendPermissionEvent, appendEventToThread, appendFelixReply, createOrLoadThread, hasThreadEvent, loadSessionState, queueThreadEvent, saveSessionState, setPendingPermission, setThreadBusy, setThreadCodexSessionId, updateThreadState, type ThreadHandle, listThreadHandles } from "./thread-store.js";
import type { ContactRecord, PermissionDecision, SessionPermissionRequest, SkillRecord, UniversalAttachment, UniversalEvent } from "./types.js";
import { loadSkills, writeSkillIndex } from "./skills.js";
import type { SourceAdapter } from "./source-adapter.js";
import { writeTextAtomic, readText, ensureDir } from "./lib/fs.js";
import { parseFrontmatter, renderFrontmatter } from "./lib/markdown.js";
import { fsTimestamp } from "./lib/time.js";

export class FelixEngine {
  private readonly sourceAdapters = new Map<string, SourceAdapter>();
  private processing = new Map<string, Promise<void>>();
  private skills: SkillRecord[] = [];

  constructor(
    private readonly cfg: AppConfig,
    adapters: SourceAdapter[],
  ) {
    for (const adapter of adapters) {
      this.sourceAdapters.set(adapter.source, adapter);
    }
  }

  async boot(): Promise<void> {
    await this.refreshSkills();
    await this.recoverThreads();
  }

  async refreshSkills(): Promise<void> {
    this.skills = await loadSkills(this.cfg);
    await writeSkillIndex(this.cfg, this.skills);
  }

  async ingest(event: UniversalEvent): Promise<void> {
    const adapter = this.requireAdapter(event.source);
    const thread = await this.findThreadHandle(event.thread_key);
    if (!this.shouldAccept(thread, event)) {
      await this.persistRawIgnored(event);
      return;
    }
    const threadHandle = thread ?? (await createOrLoadThread(this.cfg, event));
    await this.handleEventAcceptance(threadHandle, event, adapter);
  }

  private async handleEventAcceptance(
    thread: ThreadHandle,
    event: UniversalEvent,
    adapter: SourceAdapter,
  ): Promise<void> {
    if (!this.shouldAccept(thread, event)) {
      await this.persistRawIgnored(event);
      return;
    }

    if (await hasThreadEvent(thread, event.source, event.event_id)) {
      log.info("thread.event_duplicate", {
        thread_key: thread.state.thread_key,
        event_id: event.event_id,
        source: event.source,
      });
      return;
    }

    if (event.attachments.length > 0) {
      event.attachments = await Promise.all(
        event.attachments.map(async (attachment) =>
          adapter.downloadAttachment({
            event,
            attachment,
            destinationDir: thread.mediaDir,
          }),
        ),
      );
    }

    const eventFile = await appendEventToThread(thread, event);
    await updateThreadState(thread, {
      managed_by_felix: true,
      updated_at: new Date().toISOString(),
    });

    if (event.source === "mattermost") {
      await adapter.addReaction({ event, emoji: "⏳" });
    }

    const session = await loadSessionState(thread);
    const queued = await queueThreadEvent(thread, {
      received_at: event.received_at,
      event_file: eventFile,
      source_event_id: event.event_id,
    });
    if (!queued.busy) {
      void this.processThread(thread).catch((error) => {
        log.error("thread.process_failed", { thread_key: thread.state.thread_key, error: error.message });
      });
    }
  }

  private shouldAccept(thread: ThreadHandle | null, event: UniversalEvent): boolean {
    if (event.visibility === "dm") return true;
    if (thread) return thread.state.managed_by_felix;
    return event.mentions_bot;
  }

  async processThread(thread: ThreadHandle): Promise<void> {
    if (this.processing.has(thread.state.thread_key)) {
      return this.processing.get(thread.state.thread_key)!;
    }
    const promise = this.processThreadInternal(thread).finally(() => {
      this.processing.delete(thread.state.thread_key);
      void (async () => {
        const session = await loadSessionState(thread).catch(() => null);
        if (session && session.queue.length > 0 && !session.busy) {
          void this.processThread(thread).catch((error) => {
            log.error("thread.process_failed", { thread_key: thread.state.thread_key, error: error.message });
          });
        }
      })();
    });
    this.processing.set(thread.state.thread_key, promise);
    return promise;
  }

  private async processThreadInternal(thread: ThreadHandle): Promise<void> {
    await setThreadBusy(thread, true);
    try {
      await this.refreshSkills();
      await this.sanitizeThreadQueue(thread);
      while (true) {
        let session = await loadSessionState(thread);
        if (session.queue.length === 0) {
          break;
        }
        const item = session.queue.shift()!;
        await saveSessionState(thread, session);
        const event = await this.readEventFromPath(item.event_file);
        if (this.isOwnMattermostMessage(event)) {
          continue;
        }
        const contact = await loadContact(this.cfg, event.sender.source, event.sender.id);
        await this.ensureContactDefaults(contact);
        const permissionEvents = await this.collectPermissionEventPaths(thread);
        const images = event.attachments
          .filter((attachment) => attachment.is_image && attachment.local_path)
          .map((attachment) => attachment.local_path!)
          .filter(Boolean);
        let resumed = Boolean(session.codex_session_id);
        let retriedFreshStart = false;
        while (true) {
          let result;
          try {
            result = await runCodexTurn(this.cfg, {
              thread,
              event,
              eventFile: item.event_file,
              contact,
              skills: this.skills,
              skillIndexPath: path.join(this.cfg.paths.skills, "index.md"),
              permissionEvents,
              threadTranscriptPath: thread.transcriptFile,
              images,
              resumed,
            });
          } catch (error) {
            const current = await loadSessionState(thread);
            current.queue.unshift(item);
            await saveSessionState(thread, current);
            throw error;
          }
          const parsed = parseAgentOutput(result.lastMessage);
          const success = result.exitCode === 0 && hasRenderableOutput(parsed);
          if (!success && resumed && !retriedFreshStart) {
            log.warn("codex.resume_fallback", {
              thread_key: thread.state.thread_key,
              session_id: result.sessionId,
              exit_code: result.exitCode,
              log_path: result.logPath,
            });
            const current = await loadSessionState(thread);
            current.codex_session_id = undefined;
            await saveSessionState(thread, current);
            await setThreadCodexSessionId(thread, undefined);
            resumed = false;
            retriedFreshStart = true;
            continue;
          }

          if (!success) {
            const current = await loadSessionState(thread);
            current.queue.unshift(item);
            current.codex_session_id = resumed ? undefined : current.codex_session_id;
            await saveSessionState(thread, current);
            log.error("codex.empty_output", {
              thread_key: thread.state.thread_key,
              session_id: result.sessionId,
              exit_code: result.exitCode,
              log_path: result.logPath,
            });
            break;
          }

          session = await loadSessionState(thread);
          session.codex_session_id = result.sessionId;
          session.last_turn_at = new Date().toISOString();
          await saveSessionState(thread, session);
          await setThreadCodexSessionId(thread, result.sessionId);
          if (parsed.kind === "reply") {
            await this.postThreadReply(thread, event, result.sessionId, parsed.text);
            break;
          }
          if (parsed.kind === "no_skill") {
            await this.postThreadReply(thread, event, result.sessionId, parsed.text);
            break;
          }
          if (parsed.kind === "permission_required") {
            await this.handlePermissionRequired(thread, event, parsed as PermissionRequiredOutput);
            break;
          }
          if (parsed.kind === "unknown") {
            await this.postThreadReply(thread, event, result.sessionId, parsed.text);
            break;
          }
        }
      }
    } finally {
      await setThreadBusy(thread, false);
    }
  }

  private async postThreadReply(
    thread: ThreadHandle,
    event: UniversalEvent,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const adapter = this.requireAdapter(event.source);
    await adapter.sendThreadReply({ event, text });
    await appendFelixReply(thread, new Date().toISOString(), text, sessionId);
    if (event.source === "mattermost") {
      await adapter.removeReaction({ event, emoji: "⏳" });
    }
  }

  private async handlePermissionRequired(
    thread: ThreadHandle,
    event: UniversalEvent,
    parsed: PermissionRequiredOutput,
  ): Promise<void> {
    const request: SessionPermissionRequest = {
      requested_at: new Date().toISOString(),
      skill_id: parsed.skillId ?? "(unknown)",
      permissions: parsed.permissions ?? [],
      reason: parsed.reason ?? "permission required",
      owner_message: parsed.ownerMessage ?? "Owner approval required.",
      thread_key: thread.state.thread_key,
      requester: event.sender,
      requester_event_file: path.join(thread.eventsDir, `${fsTimestamp(new Date())}_permission_request.md`),
    };
    const ownerMessage = await this.notifyOwner(thread, event, request);
    request.owner_message_post_id = ownerMessage?.post_id;
    request.owner_message_channel_id = ownerMessage?.channel_id;
    await setPendingPermission(thread, request);
    await appendPermissionRequestEvent(thread, request);
    const adapter = this.requireAdapter(event.source);
    if (event.source === "mattermost") {
      await adapter.removeReaction({ event, emoji: "⏳" });
      await adapter.addReaction({ event, emoji: "🔒" });
    }
  }

  private async notifyOwner(
    thread: ThreadHandle,
    event: UniversalEvent,
    request: SessionPermissionRequest,
  ): Promise<{ post_id: string; channel_id: string } | null> {
    const ownerId = this.cfg.MATTERMOST_OWNER_USER_ID;
    if (!ownerId) {
      log.warn("owner.missing", { thread_key: thread.state.thread_key });
      return null;
    }
    const adapter = this.requireAdapter(event.source);
    const threadLink = adapter.getThreadLink(event.thread_key);
    const message = [
      `Permission request for thread ${event.thread_key}`,
      `Requester: ${event.sender.display ?? event.sender.id} (${event.sender.id})`,
      `Skill: ${request.skill_id}`,
      `Missing permissions: ${request.permissions.join(", ") || "(none)"}`,
      `Reason: ${request.reason}`,
      threadLink ? `Thread: ${threadLink}` : "",
      "",
      `Reply with one of:`,
      `- OK once`,
      `- OK always`,
      `- REJECT`,
    ]
      .filter(Boolean)
      .join("\n");
    return adapter.sendUserMessage({ userId: ownerId, text: message });
  }

  async handleOwnerDecision(event: UniversalEvent, decision: PermissionDecision): Promise<void> {
    const thread = await this.findPendingPermissionThreadForEvent(event);
    if (!thread) {
      log.warn("owner.permission_thread_not_found", {
        event_thread_key: event.thread_key,
        event_id: event.event_id,
      });
      return;
    }
    const session = await loadSessionState(thread);
    const pending = session.pending_permission;
    if (!pending) {
      return;
    }
    const now = new Date().toISOString();
    if (decision.mode === "reject") {
      const decisionFile = await appendPermissionEvent(thread, now, "rejected", {
      owner_user_id: event.sender.id,
      skill_id: pending.skill_id,
      permissions: pending.permissions,
      scope: "once",
      source_thread: thread.state.source_thread,
      reason: pending.reason,
    });
      await setPendingPermission(thread, null);
      await queueThreadEvent(thread, {
        received_at: now,
        event_file: decisionFile,
        source_event_id: `owner-reject-${now}`,
      });
      await this.processThread(thread);
      return;
    }

    const scope = decision.mode === "always" ? "always" : "once";
    const decisionFile = await appendPermissionEvent(thread, now, "approved", {
      owner_user_id: event.sender.id,
      skill_id: pending.skill_id,
      permissions: pending.permissions,
      scope,
      source_thread: thread.state.source_thread,
      reason: pending.reason,
    });
    if (decision.mode === "always") {
      const contact = await loadContact(
        this.cfg,
        pending.requester.source,
        pending.requester.id,
      );
      const next: ContactRecord = {
        ...contact,
        source: pending.requester.source,
        user_id: pending.requester.id,
        display: pending.requester.display ?? contact.display,
        username: pending.requester.username ?? contact.username,
        allowed_permissions: Array.from(new Set([...contact.allowed_permissions, ...pending.permissions])),
        allowed_skills: Array.from(new Set([...contact.allowed_skills, pending.skill_id])),
      };
      await upsertContact(this.cfg, pending.requester.source, pending.requester.id, next);
    }
    await setPendingPermission(thread, null);
    await queueThreadEvent(thread, {
      received_at: now,
      event_file: decisionFile,
      source_event_id: `owner-approve-${now}`,
    });
    await this.processThread(thread);
  }

  async recoverThreads(): Promise<void> {
    const threads = await listThreadHandles(this.cfg);
    for (const thread of threads) {
      const session = await loadSessionState(thread);
      await this.sanitizeThreadQueue(thread);
      const sanitized = await loadSessionState(thread);
      if (session.busy) {
        sanitized.busy = false;
        await saveSessionState(thread, sanitized);
      }
      if (sanitized.queue.length > 0 && !sanitized.busy) {
        void this.processThread(thread).catch((error) => {
          log.error("thread.recover_failed", { thread_key: thread.state.thread_key, error: error.message });
        });
      }
    }
  }

  private async sanitizeThreadQueue(thread: ThreadHandle): Promise<void> {
    const session = await loadSessionState(thread);
    if (session.queue.length === 0) {
      return;
    }
    const kept = [];
    let dropped = 0;
    for (const item of session.queue) {
      const event = await this.readEventFromPath(item.event_file);
      if (this.isOwnMattermostMessage(event)) {
        dropped++;
        continue;
      }
      kept.push(item);
    }
    if (dropped === 0) {
      return;
    }
    session.queue = kept;
    await saveSessionState(thread, session);
    log.info("thread.queue_sanitized", {
      thread_key: thread.state.thread_key,
      dropped,
      remaining: kept.length,
    });
  }

  private async collectPermissionEventPaths(thread: ThreadHandle): Promise<string[]> {
    const files = await fs.readdir(thread.eventsDir).catch(() => []);
    return files
      .filter((file) => file.includes("owner_permission") || file.includes("permission_request"))
      .sort()
      .map((file) => path.join(thread.eventsDir, file));
  }

  private async readEventFromPath(eventFile: string): Promise<UniversalEvent> {
    const raw = await readText(eventFile);
    const { frontmatter, body } = parseFrontmatter<{
      type?: string;
      source?: string;
      event_id?: string;
      thread_key?: string;
      received_at?: string;
      visibility?: "dm" | "channel";
      mentions_bot?: boolean;
      sender?: UniversalEvent["sender"];
      attachments?: UniversalAttachment[];
      source_thread?: UniversalEvent["source_thread"];
      owner_user_id?: string;
    }>(raw);
    if (frontmatter.type === "owner_permission") {
      return {
        source: frontmatter.source ?? "mattermost",
        event_id: frontmatter.event_id ?? path.basename(eventFile),
        thread_key: frontmatter.thread_key ?? "unknown",
        received_at: frontmatter.received_at ?? new Date().toISOString(),
        visibility: "dm",
        mentions_bot: true,
        sender: {
          source: frontmatter.source ?? "mattermost",
          id: frontmatter.owner_user_id ?? "owner",
          display: frontmatter.owner_user_id ?? "owner",
        },
        text: body.trim(),
        attachments: [],
        raw_path: eventFile,
        source_thread: frontmatter.source_thread ?? {},
      };
    }
    return {
      source: frontmatter.source ?? "mattermost",
      event_id: frontmatter.event_id ?? path.basename(eventFile),
      thread_key: frontmatter.thread_key ?? "unknown",
      received_at: frontmatter.received_at ?? new Date().toISOString(),
      visibility: frontmatter.visibility ?? "channel",
      mentions_bot: Boolean(frontmatter.mentions_bot),
      sender: frontmatter.sender ?? { source: "mattermost", id: "unknown" },
      text: body.trim(),
      attachments: frontmatter.attachments ?? [],
      raw_path: eventFile,
      source_thread: frontmatter.source_thread ?? {},
    };
  }

  private async ensureContactDefaults(contact: ContactRecord): Promise<void> {
    if (contact.allowed_permissions.length === 0 && contact.allowed_skills.length === 0 && !contact.display && !contact.username) {
      return;
    }
  }

  private requireAdapter(source: string): SourceAdapter {
    const adapter = this.sourceAdapters.get(source);
    if (!adapter) {
      throw new Error(`No source adapter for ${source}`);
    }
    return adapter;
  }

  private async persistRawIgnored(event: UniversalEvent): Promise<void> {
    await ensureDir(path.dirname(event.raw_path));
    await writeTextAtomic(event.raw_path, JSON.stringify(event, null, 2));
  }

  private isOwnMattermostMessage(event: UniversalEvent): boolean {
    return event.source === "mattermost" && Boolean(this.cfg.MATTERMOST_BOT_USER_ID) && (
      event.sender.id === this.cfg.MATTERMOST_BOT_USER_ID ||
      event.sender.id.endsWith(`:${this.cfg.MATTERMOST_BOT_USER_ID}`)
    );
  }

  private async findPendingPermissionThreadForEvent(event: UniversalEvent): Promise<ThreadHandle | null> {
    const threads = await listThreadHandles(this.cfg);
    const channelId = event.source_thread.channel_id?.trim();
    const rootId = event.source_thread.root_id?.trim();
    for (const thread of threads) {
      const session = await loadSessionState(thread);
      const pending = session.pending_permission;
      if (!pending) {
        continue;
      }
      if (
        pending.owner_message_post_id &&
        rootId &&
        pending.owner_message_post_id === rootId &&
        (!pending.owner_message_channel_id || !channelId || pending.owner_message_channel_id === channelId)
      ) {
        return thread;
      }
    }
    for (const thread of threads) {
      const session = await loadSessionState(thread);
      if (session.pending_permission && !session.pending_permission.owner_message_post_id) {
        return thread;
      }
    }
    return null;
  }

  private async findThreadHandle(threadKey: string): Promise<ThreadHandle | null> {
    const threads = await listThreadHandles(this.cfg);
    return threads.find((thread) => thread.state.thread_key === threadKey) ?? null;
  }
}

async function appendPermissionRequestEvent(
  thread: ThreadHandle,
  request: SessionPermissionRequest,
): Promise<void> {
  await writeTextAtomic(
    request.requester_event_file,
    renderFrontmatter(
      {
        type: "permission_request",
        requested_at: request.requested_at,
        skill_id: request.skill_id,
        permissions: request.permissions,
        reason: request.reason,
        owner_message: request.owner_message,
        owner_message_post_id: request.owner_message_post_id,
        owner_message_channel_id: request.owner_message_channel_id,
      },
      [
        `Permission required for ${request.skill_id}.`,
        `Permissions: ${request.permissions.join(", ") || "(none)"}`,
        `Reason: ${request.reason}`,
        `Owner message: ${request.owner_message}`,
        request.owner_message_post_id ? `Owner post: ${request.owner_message_post_id}` : "",
      ].join("\n"),
    ),
  );
  await appendFelixReply(
    thread,
    new Date().toISOString(),
    `Permission requested for ${request.skill_id}. Waiting for owner approval.`,
  );
}
