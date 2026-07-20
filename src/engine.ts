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
import { shouldAcceptEvent, isOwnMessage } from "./core/routing.js";
import { TurnRunner } from "./core/turn-runner.js";
import { createTurnCancellation } from "./core/turn-cancellation.js";
import { writeTextAtomic, readText, ensureDir } from "./lib/fs.js";
import { parseEventFile, toUniversalEvent } from "./slices/events/index.js";
import { startMemoryCron } from "./slices/memory/index.js";
import { startScheduler } from "./slices/scheduler/index.js";
import type {
  SchedulerExecutionRequest,
  SchedulerExecutionResult,
  SchedulerExecutor,
} from "./slices/scheduler/ports.js";
import type { SchedulerJob } from "./slices/scheduler/schemas.js";
import {
  AttachmentRejectedError,
  ensureSessionScopedPath,
  rejectOversizedAttachment,
  rejectedAttachment,
} from "./core/attachments.js";

function formatScheduledOutput(job: SchedulerJob, text: string): string {
  if (job.output === "detail") {
    return `Scheduled job "${job.name}" completed.\n\n${text}`;
  }
  const concise = text.replace(/\s+/g, " ").trim().slice(0, 500);
  return `Scheduled job "${job.name}" completed: ${concise}`;
}

export class FelixEngine {
  private readonly sourceAdapters = new Map<string, SourceAdapter>();
  private readonly approvalLifecycle: ApprovalRequestLifecycle;
  private processing = new Map<string, Promise<void>>();
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
    startScheduler(this.cfg, {
      run: (request) => this.runScheduledJob(request),
    });
  }

  abortThread(threadKey: string): void {
    this.cancellation.request(threadKey);
  }

  async refreshSkills(): Promise<void> {
    this.skills = await loadSkills(this.cfg);
  }

  async ingest(event: UniversalEvent): Promise<void> {
    const adapter = this.requireAdapter(event.source);
    const thread = await findThreadHandle(this.cfg, event.thread_key);
    if (!this.shouldAccept(thread, event)) {
      await this.persistRawIgnored(event);
      return;
    }
    const isNew = !thread;
    const threadHandle = thread ?? (await createOrLoadThread(this.cfg, event));
    await this.handleEventAcceptance(threadHandle, event, adapter, { isNew });
  }

  private async handleEventAcceptance(
    thread: ThreadHandle,
    event: UniversalEvent,
    adapter: SourceAdapter,
    opts?: { isNew?: boolean },
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

    if (opts?.isNew) {
      await this.notifyOwnerNewThread(thread, event, adapter);
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
        log.error("thread.process_failed", {
          thread_key: thread.state.thread_key,
          error: error.message,
        });
      });
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
    const turnRunner = this.createTurnRunner();
    try {
      await this.refreshSkills();
      await this.sanitizeThreadQueue(thread);
      while (true) {
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
          modelOverride: item.model_override,
        });
        if (result.kind === "stopped") break;
      }
    } finally {
      this.cancellation.end(thread.state.thread_key);
      await setThreadBusy(thread, false);
    }
  }

  private createTurnRunner(
    options: {
      scheduledJob?: SchedulerJob;
      onMissingPermission?: (permissions: string[]) => void;
    } = {},
  ): TurnRunner {
    return new TurnRunner(this.harness, {
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
        if (options.scheduledJob?.output === "silent") return;
        await this.postThreadError(targetThread, targetEvent, errorDetail);
      },
      postThreadReply: async (targetThread, targetEvent, sessionId, text) => {
        if (options.scheduledJob?.output === "silent") return;
        const output = options.scheduledJob
          ? formatScheduledOutput(options.scheduledJob, text)
          : text;
        await this.postThreadReply(
          targetThread,
          targetEvent,
          sessionId,
          output,
        );
      },
      requestPermission: async (targetThread, targetEvent, parsed) => {
        if (options.scheduledJob) {
          options.onMissingPermission?.(parsed.permissions);
          return;
        }
        await this.approvalLifecycle.requestPermission({
          thread: targetThread,
          event: targetEvent,
          parsed,
        });
      },
      autoGrantPermission: async (targetThread, targetEvent, sessionId) => {
        if (options.scheduledJob) return;
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
  }

  private async runScheduledJob(
    request: SchedulerExecutionRequest,
  ): Promise<SchedulerExecutionResult> {
    const { job } = request;
    await this.refreshSkills();

    const event: UniversalEvent = {
      source: job.origin.source,
      event_id: `scheduler-${job.id}-${request.executionId}`,
      thread_key: job.origin.thread_key,
      received_at: new Date().toISOString(),
      visibility: job.origin.visibility,
      mentions_bot: false,
      sender: {
        source: job.created_by.source,
        id: job.created_by.user_id,
        display: "Scheduler",
      },
      text: job.prompt,
      attachments: [],
      raw_path: "",
      source_thread_ref: job.origin.source_thread_ref,
    };

    const thread = await createOrLoadThread(this.cfg, event);
    const eventFile = await appendEventToThread(thread, event);
    const contact = await loadContact(
      this.cfg,
      job.created_by.source,
      job.created_by.user_id,
    );
    const missingAtStart = job.permissions.filter(
      (permission) => !contact.allowed_permissions.includes(permission),
    );
    if (missingAtStart.length > 0) {
      await this.postThreadReply(
        thread,
        event,
        undefined,
        `Scheduled job "${job.name}" was paused because it no longer has: ${missingAtStart.join(", ")}`,
      );
      return { status: "paused", missingPermissions: missingAtStart };
    }

    const session = await loadSessionState(thread);
    const item: SessionQueueItem = {
      received_at: event.received_at,
      event_file: eventFile,
      source_event_id: event.event_id,
      model_override: job.model,
    };
    let missingPermissions: string[] = [];
    const turnRunner = this.createTurnRunner({
      scheduledJob: job,
      onMissingPermission: (permissions) => {
        missingPermissions = permissions;
      },
    });
    const result = await turnRunner.run({
      thread,
      item,
      session,
      event,
      contact: { ...contact, allowed_permissions: job.permissions },
      skills: this.skills,
      precedingEvents: [],
      signal: request.signal,
      retryCounts: new Map(),
      modelOverride: job.model,
      propagateRunErrors: true,
    });

    if (missingPermissions.length > 0) {
      if (job.output === "silent") {
        await this.postThreadReply(
          thread,
          event,
          result.result?.sessionId,
          `Scheduled job "${job.name}" was paused because it requested: ${missingPermissions.join(", ")}`,
        );
      }
      return {
        status: "paused",
        sessionId: result.result?.sessionId,
        exitCode: result.result?.exitCode,
        logPath: result.result?.logPath,
        output: result.result?.parsed.text,
        missingPermissions,
      };
    }

    if (!result.result) {
      return {
        status: "failed",
        error: "scheduled turn completed without a result",
      };
    }
    return {
      status: result.result.success ? "success" : "failed",
      sessionId: result.result.sessionId,
      exitCode: result.result.exitCode,
      logPath: result.result.logPath,
      output: result.result.parsed.text,
    };
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
