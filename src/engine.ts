import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import {
  ApprovalRequestLifecycle,
  hasPendingApproval,
} from "./slices/approvals/index.js";
import { loadContact } from "./slices/contacts/index.js";
import { log } from "./lib/log.js";
import {
  appendEventToThread,
  appendFelixReply,
  clearThreadQueue,
  createOrLoadThread,
  filterThreadQueue,
  findThreadHandle,
  hasThreadEvent,
  loadSessionState,
  loadThreadState,
  queueThreadEvent,
  recordTurnUsage,
  setThreadBusy,
  shiftNextEvent,
  requeueEvent,
  recordTurn,
  clearHarnessSession,
  updateThreadState,
  type ThreadHandle,
  listThreadHandles,
} from "./slices/sessions/index.js";
import type {
  ContactRecord,
  OwnerDecision,
  SessionQueueItem,
  SessionState,
  SkillRecord,
  UniversalAttachment,
  UniversalEvent,
} from "./types.js";
import { loadSkills } from "./slices/skills/index.js";
import { appendUsageRecord } from "./slices/usage/index.js";
import type { Harness, SourceAdapter } from "./core/ports.js";
import {
  shouldAcceptEvent,
  isOwnMessage,
  isOwnerMessage,
} from "./core/routing.js";
import { TurnRunner } from "./core/turn-runner.js";
import { createTurnCancellation } from "./core/turn-cancellation.js";
import {
  writeTextAtomic,
  readText,
  ensureDir,
  safeFileName,
} from "./lib/fs.js";
import { parseEventFile, toUniversalEvent } from "./slices/events/index.js";
import { startMemoryCron } from "./slices/memory/index.js";
import {
  AttachmentRejectedError,
  ensureSessionScopedPath,
  rejectOversizedAttachment,
  rejectedAttachment,
} from "./core/attachments.js";

export class FelixEngine {
  private readonly sourceAdapters = new Map<string, SourceAdapter>();
  private readonly approvalLifecycle: ApprovalRequestLifecycle;
  private processing = new Map<string, Promise<void>>();
  private threadMutationLocks = new Map<string, Promise<unknown>>();
  private ownerDecisionLock: Promise<void> = Promise.resolve();
  private skills: SkillRecord[] = [];
  private readonly cancellation = createTurnCancellation();

  constructor(
    private readonly cfg: AppConfig,
    adapters: SourceAdapter[],
    private readonly harness: Harness,
  ) {
    for (const adapter of adapters) {
      this.sourceAdapters.set(adapter.source, adapter);
    }
    this.approvalLifecycle = new ApprovalRequestLifecycle(cfg, {
      sourceAdapter: (source) => this.requireAdapter(source),
      generateDecisionNotification: async (input) =>
        this.harness.generateDecisionNotification?.(input),
      ownerDisplayForSource: (source) => this.ownerDisplayForSource(source),
      warn: (message, data) => {
        log.warn(message, data);
      },
    });
  }

  async boot(): Promise<void> {
    await this.refreshSkills();
    await this.recoverThreads();
    startMemoryCron(this.cfg, this.harness);
  }

  abortThread(threadKey: string): void {
    this.cancellation.request(threadKey);
  }

  async refreshSkills(): Promise<void> {
    this.skills = await loadSkills(this.cfg);
  }

  async ingest(event: UniversalEvent): Promise<void> {
    return this.withThreadMutationLock(event.thread_key, async () => {
      const adapter = this.requireAdapter(event.source);
      const thread = await findThreadHandle(this.cfg, event.thread_key);
      // /block and /unblock are owner escape hatches — they bypass the
      // block-state check so an Owner can recover a silenced thread. They
      // still need a real thread on disk to be meaningful.
      const isBlockEscape =
        !!thread && FelixEngine.isBlockOrUnblockCommand(event);
      if (!this.shouldAccept(thread, event) && !isBlockEscape) {
        // Blocked-thread events are queued silently (no reply, no process
        // call) and replayed in order when the thread is unblocked. Anything
        // else that shouldAccept rejected is just not for us.
        if (thread?.state.blocked) {
          if (await hasThreadEvent(thread, event.source, event.event_id)) {
            log.info("thread.event_duplicate", {
              thread_key: thread.state.thread_key,
              event_id: event.event_id,
              source: event.source,
            });
            return;
          }
          await this.persistAndQueueEvent(thread, event, adapter, {
            markProcessing: false,
          });
          return;
        }
        await this.persistRawIgnored(event);
        return;
      }
      const isNew = !thread;
      const threadHandle =
        thread ?? (await createOrLoadThread(this.cfg, event));
      await this.handleEventAcceptance(threadHandle, event, adapter, { isNew });
    });
  }

  /**
   * Set the blocked flag on a thread. When transitioning to unblocked,
   * triggers processing so any events queued while the thread was blocked
   * are replayed in order. When the thread does not yet exist, a minimal
   * stub is created so the Owner can pre-emptively silence a contact
   * before any events arrive.
   */
  async setBlocked(threadKey: string, blocked: boolean): Promise<void> {
    const source = sourceFromThreadKey(threadKey);
    return this.withThreadMutationLock(threadKey, async () => {
      let thread = await findThreadHandle(this.cfg, threadKey);
      if (!thread) {
        thread = await createOrLoadThread(this.cfg, {
          source,
          thread_key: threadKey,
          source_thread_ref: { source },
          received_at: new Date().toISOString(),
        });
      }
      await updateThreadState(thread, { blocked });
      if (!blocked) {
        this.kickProcessThread(thread);
      }
    });
  }

  private async withThreadMutationLock<T>(
    threadKey: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.threadMutationLocks.get(threadKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    let tracked!: Promise<T>;
    tracked = current.finally(() => {
      if (this.threadMutationLocks.get(threadKey) === tracked) {
        this.threadMutationLocks.delete(threadKey);
      }
    });
    this.threadMutationLocks.set(threadKey, tracked);
    return tracked;
  }

  private async handleEventAcceptance(
    thread: ThreadHandle,
    event: UniversalEvent,
    adapter: SourceAdapter,
    opts?: { isNew?: boolean },
  ): Promise<void> {
    // Block/unblock commands are owner escape hatches — they bypass the
    // block-state check below. See the matching bypass in `ingest`.
    const isBlockEscape = FelixEngine.isBlockOrUnblockCommand(event);
    if (!this.shouldAccept(thread, event) && !isBlockEscape) {
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

    if (opts?.isNew) {
      await this.notifyOwnerNewThread(thread, event, adapter);
    }

    if (FelixEngine.isBlockOrUnblockCommand(event)) {
      await this.handleBlockCommand(thread, event, adapter);
      return;
    }

    if (FelixEngine.isStopCommand(event)) {
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "processing" });
      }
      const session = await loadSessionState(thread);
      if (session.busy) {
        this.abortThread(thread.state.thread_key);
        await this.drainThreadQueue(thread);
        await this.postThreadReply(thread, event, undefined, "Stopped.");
      } else {
        await this.postThreadReply(
          thread,
          event,
          undefined,
          "Nothing running.",
        );
      }
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "replied" });
      }
      return;
    }

    if (FelixEngine.isCompactCommand(event)) {
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "processing" });
      }
      const session = await loadSessionState(thread);
      if (session.harness_session_id && this.harness.compact) {
        await this.postThreadReply(
          thread,
          event,
          undefined,
          "Compacting context...",
        );
        const result = await this.harness.compact(
          session.harness_session_id,
          thread.dir,
        );
        if (result.success) {
          if (result.sessionId) {
            await recordTurn(thread, result.sessionId);
          } else {
            await clearHarnessSession(thread);
          }
          await this.postThreadReply(
            thread,
            event,
            undefined,
            "Context compacted successfully. Starting new session.",
          );
        } else {
          await this.postThreadReply(
            thread,
            event,
            undefined,
            "Failed to compact context.",
          );
        }
      } else {
        await this.postThreadReply(
          thread,
          event,
          undefined,
          "No active session to compact.",
        );
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
      await this.postThreadReply(
        thread,
        event,
        undefined,
        "Starting fresh session...",
      );
      await clearHarnessSession(thread);
      // Clear INITIAL.md so next turn generates fresh context
      const initialMdPath = path.join(thread.dir, "INITIAL.md");
      await fs.unlink(initialMdPath).catch(() => {});
      // Clear transcript
      const transcriptPath = path.join(thread.dir, "transcript.md");
      await fs.unlink(transcriptPath).catch(() => {});
      await this.postThreadReply(
        thread,
        event,
        undefined,
        "Session cleared. Starting fresh.",
      );
      if (event.mentions_bot || event.visibility === "dm") {
        await adapter.updateEventStatus({ event, status: "replied" });
      }
      return;
    }

    // Commands (/stop, /compact, /new) are handled above and return early — only
    // download attachments for messages that become real turns, so an abort
    // never blocks on fetching media it would discard.
    await this.persistAndQueueEvent(thread, event, adapter);

    const session = await loadSessionState(thread);
    if (!session.busy && (event.mentions_bot || event.visibility === "dm")) {
      this.kickProcessThread(thread);
    }
  }

  private shouldAccept(
    thread: ThreadHandle | null,
    event: UniversalEvent,
  ): boolean {
    return shouldAcceptEvent(event, thread?.state);
  }

  private static stripMentions(text: string): string {
    return text
      .replace(/<@!?\w+>/g, "")
      .replace(/@\w+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private static isStopCommand(event: UniversalEvent): boolean {
    return FelixEngine.stripMentions(event.text).toLowerCase() === "/stop";
  }

  private static isCompactCommand(event: UniversalEvent): boolean {
    return FelixEngine.stripMentions(event.text).toLowerCase() === "/compact";
  }

  private static isNewCommand(event: UniversalEvent): boolean {
    return FelixEngine.stripMentions(event.text).toLowerCase() === "/new";
  }

  private static isBlockCommand(event: UniversalEvent): boolean {
    return FelixEngine.stripMentions(event.text).toLowerCase() === "/block";
  }

  private static isUnblockCommand(event: UniversalEvent): boolean {
    return FelixEngine.stripMentions(event.text).toLowerCase() === "/unblock";
  }

  private static isBlockOrUnblockCommand(event: UniversalEvent): boolean {
    return (
      FelixEngine.isBlockCommand(event) || FelixEngine.isUnblockCommand(event)
    );
  }

  /**
   * Start a background drain of the thread queue. Errors are logged but
   * not propagated — the call sites are fire-and-forget and there is no
   * caller to surface failures to.
   */
  private kickProcessThread(thread: ThreadHandle): void {
    void this.processThread(thread).catch((error) => {
      log.error("thread.process_failed", {
        thread_key: thread.state.thread_key,
        error: error.message,
      });
    });
  }

  /**
   * Persist an event into the thread and add it to the session queue. Used
   * by both the normal accept path and the blocked-event path. Sets the
   * thread as managed_by_felix (idempotent for already-managed threads)
   * and notifies the source the event is being processed.
   */
  private async persistAndQueueEvent(
    thread: ThreadHandle,
    event: UniversalEvent,
    adapter: SourceAdapter,
    options: { markProcessing?: boolean } = {},
  ): Promise<void> {
    event.attachments = await this.prepareAttachments(thread, event, adapter);
    const eventFile = await appendEventToThread(thread, event);
    await updateThreadState(thread, {
      managed_by_felix: true,
      updated_at: new Date().toISOString(),
    });

    if (
      options.markProcessing !== false &&
      (event.mentions_bot || event.visibility === "dm")
    ) {
      await adapter.updateEventStatus({ event, status: "processing" });
    }

    await queueThreadEvent(thread, {
      received_at: event.received_at,
      event_file: eventFile,
      source_event_id: event.event_id,
    });
  }

  private async drainThreadQueue(thread: ThreadHandle): Promise<void> {
    await clearThreadQueue(thread);
  }

  private async handleBlockCommand(
    thread: ThreadHandle,
    event: UniversalEvent,
    adapter: SourceAdapter,
  ): Promise<void> {
    if (!isOwnerMessage(event, adapter.source, adapter.ownerUserId)) {
      // Non-owner attempt: silently ignore — do not leak command existence,
      // do not call the harness, do not change state.
      log.info("thread.block_command_rejected", {
        thread_key: thread.state.thread_key,
        sender: event.sender.id,
      });
      return;
    }

    const wantsBlock = FelixEngine.isBlockCommand(event);
    if (thread.state.blocked === wantsBlock) {
      const text = wantsBlock
        ? "Thread is already blocked."
        : "Thread is not blocked.";
      await this.postThreadReply(thread, event, undefined, text);
      return;
    }

    await updateThreadState(thread, { blocked: wantsBlock });
    const text = wantsBlock
      ? "Thread blocked. Felix will queue events and skip processing until unblocked."
      : "Thread unblocked. Queued events will be replayed in order.";
    await this.postThreadReply(thread, event, undefined, text);

    if (!wantsBlock) {
      this.kickProcessThread(thread);
    }
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
            log.error("thread.process_failed", {
              thread_key: thread.state.thread_key,
              error: error.message,
            });
          });
        }
      })();
    });
    this.processing.set(thread.state.thread_key, promise);
    return promise;
  }

  private async processThreadInternal(thread: ThreadHandle): Promise<void> {
    await setThreadBusy(thread, true);
    const signal = this.cancellation.begin(thread.state.thread_key);
    const retryCounts = new Map<string, number>();
    const turnRunner = new TurnRunner(this.harness, {
      sourceAdapter: (source) => this.requireAdapter(source),
      clearHarnessSession: async (targetThread) => {
        await clearHarnessSession(targetThread);
      },
      logUsage: async (targetThread, targetEvent, targetResult) => {
        await this.logUsage(targetThread, targetEvent, targetResult);
      },
      recordTurnWithUsage: async (targetThread, targetEvent, targetResult) => {
        await this.recordTurnWithUsage(targetThread, targetEvent, targetResult);
      },
      postThreadError: async (targetThread, targetEvent, errorDetail) => {
        await this.postThreadError(targetThread, targetEvent, errorDetail);
      },
      postThreadReply: async (targetThread, targetEvent, sessionId, text) => {
        await this.postThreadReply(targetThread, targetEvent, sessionId, text);
      },
      requestPermission: async (targetThread, targetEvent, parsed) => {
        await this.approvalLifecycle.requestPermission({
          thread: targetThread,
          event: targetEvent,
          parsed,
        });
      },
      autoGrantPermission: async (targetThread, targetEvent, sessionId) => {
        await this.approvalLifecycle.autoGrantPermission({
          thread: targetThread,
          event: targetEvent,
          sessionId,
        });
      },
      requeueEvent: async (targetThread, targetItem) => {
        await requeueEvent(targetThread, targetItem);
      },
      isStopRequested: (threadKey) => this.cancellation.isRequested(threadKey),
      clearStopRequested: (threadKey) => {
        this.cancellation.clear(threadKey);
      },
      warn: (message, data) => {
        log.warn(message, data);
      },
      error: (message, data) => {
        log.error(message, data);
      },
    });
    try {
      await this.refreshSkills();
      await this.sanitizeThreadQueue(thread);
      while (true) {
        // Re-check the block flag before each turn. A processThread started
        // while the thread was unblocked must not drain events that arrived
        // after a block was set.
        const liveState = await loadThreadState(thread);
        if (liveState.blocked) break;
        const preceding: { event: UniversalEvent; eventFile: string }[] = [];
        const trigger = await this.dequeueTriggerEvent(thread, preceding);
        if (!trigger) break;
        const { item, session, event } = trigger;
        await this.refreshSkills();
        const contact = await loadContact(
          this.cfg,
          event.sender.source,
          event.sender.id,
        );
        const result = await turnRunner.run({
          thread,
          item,
          session,
          event,
          contact,
          skills: this.skills,
          precedingEvents: preceding,
          signal,
          retryCounts,
        });
        if (result.kind === "stopped") break;
      }
    } finally {
      this.cancellation.end(thread.state.thread_key);
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
      if (
        perTurn.input === 0 &&
        perTurn.output === 0 &&
        perTurn.cache_write === 0 &&
        perTurn.total === 0
      ) {
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
        const oversized = rejectOversizedAttachment(
          attachment,
          this.cfg.ATTACHMENT_MAX_BYTES,
        );
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
          return rejectedAttachment(
            attachment,
            "File could not be downloaded.",
          );
        }
      }),
    );
  }

  async hasPendingPermission(
    target: OwnerDecision["target"],
  ): Promise<boolean> {
    return hasPendingApproval(this.cfg, target);
  }

  async handleOwnerDecision(decision: OwnerDecision): Promise<boolean> {
    return this.withOwnerDecisionLock(async () => {
      const outcome = await this.approvalLifecycle.applyOwnerDecision(decision);
      if (outcome.kind === "not_found") {
        return false;
      }
      if (outcome.shouldProcess) await this.processThread(outcome.thread);
      return true;
    });
  }

  private async withOwnerDecisionLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.ownerDecisionLock;
    let release!: () => void;
    const current = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
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
          log.error("thread.recover_failed", {
            thread_key: thread.state.thread_key,
            error: error.message,
          });
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
  ): Promise<{
    item: SessionQueueItem;
    session: SessionState;
    event: UniversalEvent;
  } | null> {
    while (true) {
      const next = await shiftNextEvent(thread);
      if (!next) return null;
      const event = await this.readEventFromPath(next.item.event_file);
      if (this.isOwnMessage(event)) continue;
      if (
        event.mentions_bot ||
        event.visibility === "dm" ||
        event.sender.id === "system"
      ) {
        return { item: next.item, session: next.session, event };
      }
      preceding.push({ event, eventFile: next.item.event_file });
    }
  }

  private ownerDisplayForSource(source: string): string | undefined {
    const adapterDisplay = this.sourceAdapters.get(source)?.ownerDisplay;
    if (adapterDisplay) return adapterDisplay;
    const map: Record<string, string> = {
      mattermost: this.cfg.MATTERMOST_OWNER_DISPLAY,
      discord: this.cfg.DISCORD_OWNER_DISPLAY,
      slack: this.cfg.SLACK_OWNER_DISPLAY,
      whatsapp: this.cfg.WHATSAPP_OWNER_DISPLAY,
      telegram: this.cfg.TELEGRAM_OWNER_DISPLAY,
    };
    return map[source];
  }

  private async notifyOwnerNewThread(
    thread: ThreadHandle,
    event: UniversalEvent,
    adapter: SourceAdapter,
  ): Promise<void> {
    // Skip if sender is the owner (owner initiated the conversation)
    if (adapter.ownerUserId && adapter.ownerUserId === event.sender.id) return;

    const ownerId = adapter.ownerUserId;
    if (!ownerId) return;

    const mention = event.sender.display
      ? `${event.sender.display} (${event.sender.id})`
      : event.sender.id;
    const preview = event.text?.trim() || "[media]";
    const truncated =
      preview.length > 100 ? `${preview.slice(0, 100)}...` : preview;
    const threadLink = await adapter
      .getThreadLink(thread.state.thread_key)
      .catch(() => undefined);
    const linkPart = threadLink ? `\n${threadLink}` : "";
    const text = `New thread by ${mention}.\n"${truncated}"${linkPart}`;

    try {
      await adapter.sendUserMessage({ userId: ownerId, text });
    } catch (error) {
      log.warn("thread.new_notification_failed", {
        thread_key: thread.state.thread_key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function sourceFromThreadKey(threadKey: string): string {
  if (!threadKey || /[\\/\0]/.test(threadKey)) {
    throw new Error(`Invalid thread key: ${threadKey}`);
  }
  const source = threadKey.split(":", 1)[0] ?? "";
  if (
    !source ||
    source === "." ||
    source === ".." ||
    safeFileName(source) !== source
  ) {
    throw new Error(`Invalid thread key source: ${source}`);
  }
  return source;
}
