import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "./config.js";
import { hasPendingApproval, requestApproval } from "./slices/approvals/index.js";
import { loadContact } from "./slices/contacts/index.js";
import { log } from "./lib/log.js";
import { appendEventToThread, appendFelixReply, clearThreadQueue, createOrLoadThread, filterThreadQueue, findThreadHandle, hasThreadEvent, loadSessionState, queueThreadEvent, recordTurnUsage, setThreadBusy, shiftNextEvent, requeueEvent, recordTurn, clearHarnessSession, updateThreadState, type ThreadHandle, listThreadHandles } from "./slices/sessions/index.js";
import { applyOwnerDecision, type ApprovalRecord } from "./slices/approvals/index.js";
import type { ContactRecord, OwnerDecision, SessionPermissionRequest, SessionQueueItem, SessionState, SkillRecord, SourceMessageAnchor, UniversalAttachment, UniversalEvent } from "./types.js";
import { loadSkills, writeSkillIndex } from "./slices/skills/index.js";
import { appendUsageRecord } from "./slices/usage/index.js";
import type { Harness, PermissionRequiredOutput, SourceAdapter } from "./core/ports.js";
import { shouldAcceptEvent, isOwnMessage } from "./core/routing.js";
import { fallbackNotification } from "./core/harness-common.js";
import { decideTurnResult } from "./core/decide-turn.js";
import { writeTextAtomic, readText, ensureDir } from "./lib/fs.js";
import { parseEventFile, toUniversalEvent } from "./slices/events/index.js";
import { fsTimestamp } from "./lib/time.js";
import { startMemoryCron } from "./slices/memory/index.js";
import {
  AttachmentRejectedError,
  ensureSessionScopedPath,
  rejectOversizedAttachment,
  rejectedAttachment,
} from "./core/attachments.js";

export class FelixEngine {
  private readonly sourceAdapters = new Map<string, SourceAdapter>();
  private processing = new Map<string, Promise<void>>();
  private ownerDecisionLock: Promise<void> = Promise.resolve();
  private skills: SkillRecord[] = [];
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly stopRequested = new Set<string>();

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
    startMemoryCron(this.cfg, this.harness);
  }

  abortThread(threadKey: string): void {
    this.stopRequested.add(threadKey);
    const ctrl = this.abortControllers.get(threadKey);
    if (ctrl) ctrl.abort();
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

    if (FelixEngine.isStopCommand(event)) {
      const session = await loadSessionState(thread);
      if (session.busy) {
        this.abortThread(thread.state.thread_key);
        await this.drainThreadQueue(thread);
        await this.postThreadReply(thread, event, undefined, "Stopped.");
      } else {
        await this.postThreadReply(thread, event, undefined, "Nothing running.");
      }
      return;
    }

    if (FelixEngine.isCompactCommand(event)) {
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "processing" });
      }
      const session = await loadSessionState(thread);
      if (session.harness_session_id && this.harness.compact) {
        await this.postThreadReply(thread, event, undefined, "Compacting context...");
        const success = await this.harness.compact(session.harness_session_id, thread.dir);
        if (success) {
          await clearHarnessSession(thread);
          await this.postThreadReply(thread, event, undefined, "Context compacted successfully. Starting new session.");
        } else {
          await this.postThreadReply(thread, event, undefined, "Failed to compact context.");
        }
      } else {
        await this.postThreadReply(thread, event, undefined, "No active session to compact.");
      }
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "replied" });
      }
      return;
    }

    if (FelixEngine.isNewCommand(event)) {
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "processing" });
      }
      await this.postThreadReply(thread, event, undefined, "Starting fresh session...");
      await clearHarnessSession(thread);
      // Clear INITIAL.md so next turn generates fresh context
      const initialMdPath = path.join(thread.dir, "INITIAL.md");
      await fs.promises.unlink(initialMdPath).catch(() => {});
      // Clear transcript
      const transcriptPath = path.join(thread.dir, "transcript.md");
      await fs.promises.unlink(transcriptPath).catch(() => {});
      await this.postThreadReply(thread, event, undefined, "Session cleared. Starting fresh.");
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "replied" });
      }
      return;
    }

    event.attachments = await this.prepareAttachments(thread, event, adapter);

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

  private static isStopCommand(event: UniversalEvent): boolean {
    return event.text.trim().toLowerCase() === "/stop";
  }

  private static isCompactCommand(event: UniversalEvent): boolean {
    return event.text.trim().toLowerCase() === "/compact";
  }

  private static isNewCommand(event: UniversalEvent): boolean {
    return event.text.trim().toLowerCase() === "/new";
  }

  private async drainThreadQueue(thread: ThreadHandle): Promise<void> {
    await clearThreadQueue(thread);
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
    const controller = new AbortController();
    this.abortControllers.set(thread.state.thread_key, controller);
    const retryCounts = new Map<string, number>();
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
          if (this.stopRequested.has(thread.state.thread_key)) break;
          let result;
          const typingInterval = setInterval(() => {
            adapter.sendTyping({ event }).catch(() => {});
          }, 250);
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
              signal: controller.signal,
            });
          } catch (error) {
            clearInterval(typingInterval);
            if (this.stopRequested.has(thread.state.thread_key)) {
              this.stopRequested.delete(thread.state.thread_key);
              break;
            }
            const retryCount = retryCounts.get(item.source_event_id) ?? 0;
            if (retryCount >= 2) {
              const detail = error instanceof Error ? `${error.message}. ` : "";
              await this.postThreadError(thread, event, detail);
              break;
            }
            retryCounts.set(item.source_event_id, retryCount + 1);
            await requeueEvent(thread, item);
            const detail = error instanceof Error ? `${error.message}. ` : "";
            await this.postThreadError(thread, event, detail);
            break;
          }
          clearInterval(typingInterval);
          if (this.stopRequested.has(thread.state.thread_key)) break;
          const decision = decideTurnResult(result, resumed, retriedFreshStart);
          if (decision.kind === "retry_fresh") {
            log.warn("harness.resume_fallback", {
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
            if (resumed) {
              await clearHarnessSession(thread);
            }
            const detail = result.exitCode !== 0
              ? exitCodeMessage(result.exitCode)
              : "The agent produced no usable output. ";
            await this.postThreadError(thread, event, detail);
            log.error("harness.empty_output", {
              thread_key: thread.state.thread_key,
              session_id: result.sessionId,
              exit_code: result.exitCode,
              log_path: result.logPath,
            });
            break;
          }
          if (decision.kind === "format_retry") {
            log.warn("harness.format_error", {
              thread_key: thread.state.thread_key,
              session_id: result.sessionId,
              error: result.parsed.text,
            });
            // The malformed first attempt already burned tokens — record them
            // before the correction re-run so the ledger isn't undercounted.
            await this.logUsage(thread, event, result);
            const correctionPrompt = [
              "Your last output had a format error:",
              "",
              result.parsed.text,
              "",
              "Please re-read the latest event and produce a correctly formatted PERMISSION_REQUIRED block.",
              "Make sure every field is filled: skill, permissions (with at least one `- <name>` bullet), reason, owner_message, and end with END_PERMISSION_REQUIRED.",
            ].join("\n");
            try {
              result = await this.harness.run({
                thread,
                event,
                eventFile: item.event_file,
                contact,
                skills: this.skills,
                sourceContext,
                resumed: true,
                precedingEvents: preceding.length > 0 ? preceding : undefined,
                promptOverride: correctionPrompt,
                signal: controller.signal,
              });
            } catch (error) {
              clearInterval(typingInterval);
              if (this.stopRequested.has(thread.state.thread_key)) {
                this.stopRequested.delete(thread.state.thread_key);
                break;
              }
              const retryCount = retryCounts.get(item.source_event_id) ?? 0;
              if (retryCount >= 2) {
                const detail = error instanceof Error ? `${error.message}. ` : "";
                await this.postThreadError(thread, event, detail);
                break;
              }
              retryCounts.set(item.source_event_id, retryCount + 1);
              await requeueEvent(thread, item);
              const detail = error instanceof Error ? `${error.message}. ` : "";
              await this.postThreadError(thread, event, detail);
              break;
            }
            if (this.stopRequested.has(thread.state.thread_key)) break;
            const retriedDecision = decideTurnResult(result, true, retriedFreshStart);
            if (retriedDecision.kind === "retry_fresh") {
              await clearHarnessSession(thread);
              resumed = false;
              retriedFreshStart = true;
              continue;
            }
            if (retriedDecision.kind === "fail" || retriedDecision.kind === "format_retry") {
              if (resumed) {
                await clearHarnessSession(thread);
              }
              await this.postThreadError(thread, event, "The agent produced no usable output. ");
              break;
            }
            await this.recordTurnWithUsage(thread, event, result);
            if (retriedDecision.kind === "permission_required") {
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
          await this.recordTurnWithUsage(thread, event, result);
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
      this.abortControllers.delete(thread.state.thread_key);
      this.stopRequested.delete(thread.state.thread_key);
      await setThreadBusy(thread, false);
    }
  }

  private async postThreadReply(
    thread: ThreadHandle,
    event: UniversalEvent,
    sessionId: string | undefined,
    text: string,
  ): Promise<void> {
    const adapter = this.requireAdapter(event.source);
    await adapter.sendThreadReply({ event, text });
    await appendFelixReply(thread, new Date().toISOString(), text, sessionId);
    await adapter.updateEventStatus({ event, status: "replied" });
  }

  /**
   * Persist the turn (harness session + timestamp) and log its token usage.
   */
  private async recordTurnWithUsage(
    thread: ThreadHandle,
    event: UniversalEvent,
    result: import("./core/ports.js").TurnResult,
  ): Promise<void> {
    await recordTurn(thread, result.sessionId);
    await this.logUsage(thread, event, result);
  }

  /**
   * Append a per-turn usage record for monitoring. Best-effort — a failure must
   * never break the turn. Handles two correctness concerns:
   *  - codex reports session-cumulative usage, so we delta against the thread's
   *    last-seen total (the `>= stored` guard self-corrects on session resets);
   *  - synthetic "system" turns (post-approval proceed) are attributed back to the
   *    last human sender so the work lands under the requester, not "system".
   */
  private async logUsage(
    thread: ThreadHandle,
    event: UniversalEvent,
    result: import("./core/ports.js").TurnResult,
  ): Promise<void> {
    if (!result.usage) return;
    try {
      const { contactId, usage: perTurn } = await recordTurnUsage(thread, {
        sender: event.sender,
        usage: result.usage,
        cumulative: result.usageCumulative,
      });

      // After deltaing, a duplicate cumulative snapshot yields nothing to record.
      if (perTurn.input === 0 && perTurn.output === 0 && perTurn.cache_write === 0 && perTurn.total === 0) {
        return;
      }

      await appendUsageRecord(this.cfg, {
        schema_version: 1,
        at: new Date().toISOString(),
        source: event.source,
        contact_id: contactId,
        thread_key: thread.state.thread_key,
        harness: this.cfg.HARNESS,
        model: perTurn.model,
        input: perTurn.input,
        output: perTurn.output,
        cache_read: perTurn.cache_read,
        cache_write: perTurn.cache_write,
        total: perTurn.total,
      });
    } catch (error) {
      log.warn("usage.record_failed", {
        thread_key: thread.state.thread_key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async postThreadError(
    thread: ThreadHandle,
    event: UniversalEvent,
    errorDetail: string,
  ): Promise<void> {
    const text = `Something went wrong while processing your request. ${errorDetail}Please try again later.`;
    try {
      await this.postThreadReply(thread, event, undefined, text);
    } catch {
      log.warn("thread.error_reply_failed", {
        thread_key: thread.state.thread_key,
        error: errorDetail,
      });
    }
  }

  private async prepareAttachments(
    thread: ThreadHandle,
    event: UniversalEvent,
    adapter: SourceAdapter,
  ): Promise<UniversalAttachment[]> {
    if (event.attachments.length === 0) return event.attachments;

    return Promise.all(
      event.attachments.map(async (attachment) => {
        const oversized = rejectOversizedAttachment(attachment, this.cfg.ATTACHMENT_MAX_BYTES);
        if (oversized) return oversized;
        try {
          const downloaded = await adapter.downloadAttachment({
            event,
            attachment,
            destinationDir: thread.attachmentsDir,
            maxBytes: this.cfg.ATTACHMENT_MAX_BYTES,
          });
          ensureSessionScopedPath(downloaded.local_path, thread.attachmentsDir);
          return {
            ...downloaded,
            status: downloaded.status ?? "available",
          };
        } catch (error) {
          if (error instanceof AttachmentRejectedError) {
            return rejectedAttachment(attachment, error.reason);
          }
          log.warn("attachment.download_failed", {
            thread_key: thread.state.thread_key,
            event_id: event.event_id,
            file_id: attachment.file_id,
            error: error instanceof Error ? error.message : String(error),
          });
          return rejectedAttachment(attachment, "File could not be downloaded.");
        }
      }),
    );
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
      // un-anchored reaction/reply cannot be matched directly, so the owner
      // console / approval list is the only exact decision path.
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
    const targetSource = this.cfg.OWNER_CHANNEL ?? event.source;
    const adapter = this.requireAdapter(targetSource);
    const ownerId = adapter.ownerUserId;
    if (!ownerId) {
      log.warn("owner.missing", { source: targetSource, thread_key: thread.state.thread_key });
      return null;
    }
    const threadLink = await adapter.getThreadLink(event.thread_key);
    const message = await adapter.formatOwnerNotification({
      skillId: request.skill_id,
      permissions: request.permissions,
      reason: request.reason,
      requesterName: event.sender.display ?? event.sender.id,
      requesterId: event.sender.id,
      threadLink,
      status: "pending",
    });
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
    return hasPendingApproval(this.cfg, target);
  }

  async handleOwnerDecision(decision: OwnerDecision): Promise<boolean> {
    return this.withOwnerDecisionLock(async () => {
      const outcome = await applyOwnerDecision(this.cfg, decision);
      if (!outcome) {
        return false;
      }
      if (outcome.record) {
        await this.updateOwnerDecisionMessage(outcome.thread, outcome.record, decision.mode);
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
      return true;
    });
  }

  private async withOwnerDecisionLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.ownerDecisionLock;
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    this.ownerDecisionLock = current;

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.ownerDecisionLock === current) {
        this.ownerDecisionLock = Promise.resolve();
      }
    }
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

  private async updateOwnerDecisionMessage(
    thread: ThreadHandle,
    record: ApprovalRecord,
    mode: OwnerDecision["mode"],
  ): Promise<void> {
    const anchor = record.ownerMessageAnchor;
    if (!anchor) return;
    const targetSource = this.cfg.OWNER_CHANNEL ?? thread.state.source;
    const adapter = this.requireAdapter(targetSource);
    if (!adapter.editUserMessage) return;
    try {
      const message = await adapter.formatOwnerNotification({
        skillId: record.skillId,
        permissions: record.permissions,
        reason: record.reason,
        requesterName: record.requester.display ?? record.requester.username ?? record.requester.id,
        requesterId: record.requester.id,
        threadLink: await adapter.getThreadLink(thread.state.thread_key),
        status: record.status,
        decisionMode: mode,
        decidedAt: record.decidedAt,
      });
      await adapter.editUserMessage({ anchor, text: message });
    } catch (error) {
      log.warn("owner.edit_notification_failed", {
        thread_key: thread.state.thread_key,
        source: thread.state.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    const result = await filterThreadQueue(thread, async (item) => {
      const event = await this.readEventFromPath(item.event_file);
      if (this.isOwnMessage(event)) {
        return false;
      }
      return true;
    });
    if (result.dropped === 0) {
      return;
    }
    log.info("thread.queue_sanitized", {
      thread_key: thread.state.thread_key,
      dropped: result.dropped,
      remaining: result.remaining,
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
      whatsapp: this.cfg.WHATSAPP_OWNER_DISPLAY,
    };
    return map[source];
  }

}

export function namespacePermissions(skillId: string, permissions: string[]): string[] {
  return permissions.map((p) => (p.includes(":") ? p : `${skillId}:${p}`));
}

function exitCodeMessage(exitCode: number): string {
  switch (exitCode) {
    case -1:
      return "The agent process could not start. ";
    case 1:
      return "The agent process encountered an error. ";
    case 2:
      return "The agent process received invalid input. ";
    case 126:
      return "The agent binary is not executable. ";
    case 127:
      return "The agent binary was not found. ";
    case 137:
      return "The agent process was killed (out of memory or timeout). ";
    case 143:
      return "The agent process was terminated. ";
    default:
      return `The agent process exited with code ${exitCode}. `;
  }
}
