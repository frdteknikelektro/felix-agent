import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "./config.js";
import { requestApproval } from "./slices/approvals/index.js";
import { loadContact } from "./slices/contacts/index.js";
import { log } from "./lib/log.js";
import { appendEventToThread, appendFelixReply, createOrLoadThread, findThreadHandle, hasThreadEvent, loadSessionState, queueThreadEvent, saveSessionState, setThreadBusy, shiftNextEvent, requeueEvent, recordTurn, clearHarnessSession, updateThreadState, type ThreadHandle, listThreadHandles } from "./slices/sessions/index.js";
import { applyOwnerDecision, resolvePendingPermissionThread } from "./slices/approvals/index.js";
import type { ContactRecord, OwnerDecision, SessionPermissionRequest, SessionQueueItem, SessionState, SkillRecord, SourceMessageAnchor, UniversalEvent } from "./types.js";
import { loadSkills, writeSkillIndex } from "./slices/skills/index.js";
import type { Harness, PermissionRequiredOutput, SourceAdapter } from "./core/ports.js";
import { shouldAcceptEvent, isOwnMessage } from "./core/routing.js";
import { fallbackNotification } from "./core/harness-common.js";
import { decideTurnResult } from "./core/decide-turn.js";
import { writeTextAtomic, readText, ensureDir } from "./lib/fs.js";
import { parseEventFile, toUniversalEvent } from "./slices/events/index.js";
import { fsTimestamp } from "./lib/time.js";

export class FelixEngine {
  private readonly sourceAdapters = new Map<string, SourceAdapter>();
  private processing = new Map<string, Promise<void>>();
  private skills: SkillRecord[] = [];

  constructor(
    private readonly cfg: AppConfig,
    adapters: SourceAdapter[],
    private readonly harness: Harness,
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
    const thread = await findThreadHandle(this.cfg, event.thread_key);
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
            destinationDir: thread.attachmentsDir,
          }),
        ),
      );
    }

    const eventFile = await appendEventToThread(thread, event);
    await updateThreadState(thread, {
      managed_by_felix: true,
      updated_at: new Date().toISOString(),
    });

    if (event.mentions_bot || event.visibility === "dm") {
      await adapter.updateEventStatus({ event, status: "processing" });
    }

    const queued = await queueThreadEvent(thread, {
      received_at: event.received_at,
      event_file: eventFile,
      source_event_id: event.event_id,
    });
    if (!queued.busy && (event.mentions_bot || event.visibility === "dm")) {
      void this.processThread(thread).catch((error) => {
        log.error("thread.process_failed", { thread_key: thread.state.thread_key, error: error.message });
      });
    }
  }

  private shouldAccept(thread: ThreadHandle | null, event: UniversalEvent): boolean {
    return shouldAcceptEvent(event, thread?.state);
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
        const preceding: { event: UniversalEvent; eventFile: string }[] = [];
        const trigger = await this.dequeueTriggerEvent(thread, preceding);
        if (!trigger) break;
        const { item, session, event } = trigger;
        const contact = await loadContact(this.cfg, event.sender.source, event.sender.id);
        const adapter = this.requireAdapter(event.source);
        const sourceContext = await adapter.getTurnContext({ event });
        let resumed = Boolean(session.harness_session_id);
        let retriedFreshStart = false;
        while (true) {
          let result;
          const typingInterval = setInterval(() => {
            adapter.sendTyping({ event }).catch(() => {});
          }, 1000);
          try {
            result = await this.harness.run({
              thread,
              event,
              eventFile: item.event_file,
              contact,
              skills: this.skills,
              sourceContext,
              resumed,
              precedingEvents: preceding.length > 0 ? preceding : undefined,
            });
          } catch (error) {
            clearInterval(typingInterval);
            await requeueEvent(thread, item);
            throw error;
          }
          clearInterval(typingInterval);
          const decision = decideTurnResult(result, resumed, retriedFreshStart);
          if (decision.kind === "retry_fresh") {
            log.warn("codex.resume_fallback", {
              thread_key: thread.state.thread_key,
              session_id: result.sessionId,
              exit_code: result.exitCode,
              log_path: result.logPath,
            });
            await clearHarnessSession(thread);
            resumed = false;
            retriedFreshStart = true;
            continue;
          }
          if (decision.kind === "fail") {
            await requeueEvent(thread, item, { clearHarnessSession: resumed });
            log.error("codex.empty_output", {
              thread_key: thread.state.thread_key,
              session_id: result.sessionId,
              exit_code: result.exitCode,
              log_path: result.logPath,
            });
            break;
          }
          await recordTurn(thread, result.sessionId);
          if (decision.kind === "permission_required") {
            const permOutput = result.parsed as PermissionRequiredOutput;
            const skillId = permOutput.skillId ?? "(unknown)";
            const bareMissing = (permOutput.permissions ?? []).filter(
              (bare) => !contact.allowed_permissions.includes(`${skillId}:${bare}`),
            );
            if (bareMissing.length === 0) {
              await this.autoGrantPermission(thread, event, result.sessionId, permOutput, skillId);
            } else {
              await this.postThreadReply(thread, event, result.sessionId, permOutput.text);
              await this.handlePermissionRequired(thread, event, {
                ...permOutput,
                permissions: bareMissing,
              });
            }
          } else {
            await this.postThreadReply(thread, event, result.sessionId, result.parsed.text);
          }
          break;
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
    await adapter.updateEventStatus({ event, status: "replied" });
  }

  private async handlePermissionRequired(
    thread: ThreadHandle,
    event: UniversalEvent,
    parsed: PermissionRequiredOutput,
  ): Promise<void> {
    const skillId = parsed.skillId ?? "(unknown)";
    const request: SessionPermissionRequest = {
      request_id: crypto.randomUUID(),
      requested_at: new Date().toISOString(),
      skill_id: skillId,
      permissions: namespacePermissions(skillId, parsed.permissions ?? []),
      reason: parsed.reason ?? "permission required",
      owner_message: parsed.ownerMessage ?? "Owner approval required.",
      thread_key: thread.state.thread_key,
      requester: event.sender,
      requester_event_file: path.join(thread.eventsDir, `${fsTimestamp(new Date())}_permission_request.md`),
    };
    const ownerMessage = await this.notifyOwner(thread, event, request);
    request.owner_message_anchor = ownerMessage ?? undefined;
    if (!ownerMessage) {
      // The request is still persisted below so the owner can act on it — an
      // un-anchored reply resolves via resolvePendingPermissionThread's fallback
      // — but without a post id we can't match a reply to this thread by post,
      // so flag it for the operator.
      log.warn("owner.notify_undelivered", {
        thread_key: thread.state.thread_key,
        request_id: request.request_id,
        skill_id: request.skill_id,
      });
    }
    await requestApproval(this.cfg, thread, request);
    const adapter = this.requireAdapter(event.source);
    await adapter.updateEventStatus({ event, status: "permission_required" });
  }

  private async autoGrantPermission(
    thread: ThreadHandle,
    event: UniversalEvent,
    sessionId: string,
    _permOutput: PermissionRequiredOutput,
    _skillId: string,
  ): Promise<void> {
    const adapter = this.requireAdapter(event.source);
    const text = fallbackNotification("once");
    await adapter.sendThreadReply({ event, text });
    await adapter.updateEventStatus({ event, status: "replied" });
    await appendFelixReply(thread, new Date().toISOString(), text, sessionId);
    await this.queueProceedEvent(thread);
  }

  private async notifyOwner(
    thread: ThreadHandle,
    event: UniversalEvent,
    request: SessionPermissionRequest,
  ): Promise<SourceMessageAnchor | null> {
    const adapter = this.requireAdapter(event.source);
    const ownerId = adapter.ownerUserId;
    if (!ownerId) {
      log.warn("owner.missing", { source: event.source, thread_key: thread.state.thread_key });
      return null;
    }
    const threadLink = await adapter.getThreadLink(event.thread_key);
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
    try {
      return await adapter.sendUserMessage({ userId: ownerId, text: message });
    } catch (error) {
      log.warn("owner.notify_failed", {
        thread_key: thread.state.thread_key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async hasPendingPermission(target: OwnerDecision["target"]): Promise<boolean> {
    const thread = await resolvePendingPermissionThread(this.cfg, target);
    if (!thread) return false;
    const session = await loadSessionState(thread);
    return Boolean(session.pending_permission);
  }

  async handleOwnerDecision(decision: OwnerDecision): Promise<void> {
    const outcome = await applyOwnerDecision(this.cfg, decision);
    if (!outcome) {
      return;
    }
    const notification = await this.harness.generateDecisionNotification?.({
      thread: outcome.thread,
      mode: decision.mode,
      skillId: outcome.record?.skillId ?? "(unknown)",
      reason: outcome.record?.reason ?? "",
      ownerDisplay: this.ownerDisplayForSource(outcome.thread.state.source),
    });
    if (notification) {
      await this.postDecisionNotification(outcome.thread, notification);
    }
    if (decision.mode !== "reject") {
      await this.queueProceedEvent(outcome.thread);
    }
    await this.processThread(outcome.thread);
  }

  private async postDecisionNotification(thread: ThreadHandle, text: string): Promise<void> {
    const source = thread.state.source;
    const ref = thread.state.source_thread_ref;
    try {
      const adapter = this.requireAdapter(source);
      if (!ref) {
        log.warn("thread.no_source_thread_ref", {
          thread_key: thread.state.thread_key,
          source,
        });
      } else {
        const event: UniversalEvent = {
          source,
          thread_key: thread.state.thread_key,
          event_id: `decision-notify-${Date.now()}`,
          received_at: new Date().toISOString(),
          visibility: "channel",
          mentions_bot: false,
          sender: { source, id: "system" },
          text,
          attachments: [],
          raw_path: "",
          source_thread_ref: ref,
        };
        await adapter.sendThreadReply({ event, text });
      }
    } catch (error) {
      log.warn("thread.decision_notify_post_failed", {
        thread_key: thread.state.thread_key,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await appendFelixReply(thread, new Date().toISOString(), text);
  }

  /**
   * Queue a synthetic system event that tells the LLM to proceed with the
   * pending work. Called after auto-grant and after owner approval, so the
   * LLM gets a turn to actually execute.
   */
  private async queueProceedEvent(thread: ThreadHandle): Promise<void> {
    const ref = thread.state.source_thread_ref;
    if (!ref) return;
    const source = thread.state.source;
    const proceedEvent: UniversalEvent = {
      source,
      thread_key: thread.state.thread_key,
      event_id: `proceed-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      received_at: new Date().toISOString(),
      visibility: "channel",
      mentions_bot: false,
      sender: { source, id: "system" },
      text: "Permission granted. Proceed with the pending request.",
      attachments: [],
      raw_path: "",
      source_thread_ref: ref,
    };
    const eventFile = await appendEventToThread(thread, proceedEvent);
    await queueThreadEvent(thread, {
      received_at: proceedEvent.received_at,
      event_file: eventFile,
      source_event_id: proceedEvent.event_id,
    });
  }

  /** Wait for all in-flight thread processing to settle, up to timeoutMs. */
  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.processing.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled(Array.from(this.processing.values())),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
  }

  async recoverThreads(): Promise<void> {
    const threads = await listThreadHandles(this.cfg);
    for (const thread of threads) {
      const session = await loadSessionState(thread);
      await this.sanitizeThreadQueue(thread);
      if (session.busy) {
        await setThreadBusy(thread, false);
      }
      const sanitized = await loadSessionState(thread);
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
      if (this.isOwnMessage(event)) {
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

  private async readEventFromPath(eventFile: string): Promise<UniversalEvent> {
    const raw = await readText(eventFile);
    return toUniversalEvent(parseEventFile(raw), eventFile);
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

  private isOwnMessage(event: UniversalEvent): boolean {
    const adapter = this.requireAdapter(event.source);
    return isOwnMessage(event, adapter.source, adapter.botUserId);
  }

  private async dequeueTriggerEvent(
    thread: ThreadHandle,
    preceding: { event: UniversalEvent; eventFile: string }[],
  ): Promise<{ item: SessionQueueItem; session: SessionState; event: UniversalEvent } | null> {
    while (true) {
      const next = await shiftNextEvent(thread);
      if (!next) return null;
      const event = await this.readEventFromPath(next.item.event_file);
      if (this.isOwnMessage(event)) continue;
      if (event.mentions_bot || event.visibility === "dm" || event.sender.id === "system") {
        return { item: next.item, session: next.session, event };
      }
      preceding.push({ event, eventFile: next.item.event_file });
    }
  }

  private ownerDisplayForSource(source: string): string | undefined {
    const map: Record<string, string> = {
      mattermost: this.cfg.MATTERMOST_OWNER_DISPLAY,
      discord: this.cfg.DISCORD_OWNER_DISPLAY,
      slack: this.cfg.SLACK_OWNER_DISPLAY,
    };
    return map[source];
  }

}

export function namespacePermissions(skillId: string, permissions: string[]): string[] {
  return permissions.map((p) => (p.includes(":") ? p : `${skillId}:${p}`));
}
