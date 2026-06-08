import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "./config.js";
import { requestApproval } from "./slices/approvals/index.js";
import { loadContact } from "./slices/contacts/index.js";
import { log } from "./lib/log.js";
import { appendEventToThread, appendFelixReply, createOrLoadThread, findThreadHandle, hasThreadEvent, loadSessionState, queueThreadEvent, saveSessionState, setThreadBusy, shiftNextEvent, requeueEvent, recordTurn, clearCodexSession, updateThreadState, type ThreadHandle, listThreadHandles } from "./slices/sessions/index.js";
import { applyOwnerDecision, resolvePendingPermissionThread } from "./slices/approvals/index.js";
import type { ContactRecord, OwnerDecision, SessionPermissionRequest, SkillRecord, SourceMessageAnchor, UniversalEvent } from "./types.js";
import { loadSkills, writeSkillIndex } from "./slices/skills/index.js";
import type { Harness, PermissionRequiredOutput, SourceAdapter } from "./core/ports.js";
import { shouldAcceptEvent, isOwnMattermostMessage } from "./core/routing.js";
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

    await adapter.updateEventStatus({ event, status: "processing" });

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
        const next = await shiftNextEvent(thread);
        if (!next) {
          break;
        }
        const { item, session } = next;
        const event = await this.readEventFromPath(item.event_file);
        if (this.isOwnMattermostMessage(event)) {
          continue;
        }
        const contact = await loadContact(this.cfg, event.sender.source, event.sender.id);
        const adapter = this.requireAdapter(event.source);
        const sourceContext = await adapter.getTurnContext({ event });
        let resumed = Boolean(session.codex_session_id);
        let retriedFreshStart = false;
        while (true) {
          let result;
          try {
            result = await this.harness.run({
              thread,
              event,
              eventFile: item.event_file,
              contact,
              skills: this.skills,
              sourceContext,
              resumed,
            });
          } catch (error) {
            await requeueEvent(thread, item);
            throw error;
          }
          const decision = decideTurnResult(result, resumed, retriedFreshStart);
          if (decision.kind === "retry_fresh") {
            log.warn("codex.resume_fallback", {
              thread_key: thread.state.thread_key,
              session_id: result.sessionId,
              exit_code: result.exitCode,
              log_path: result.logPath,
            });
            await clearCodexSession(thread);
            resumed = false;
            retriedFreshStart = true;
            continue;
          }
          if (decision.kind === "fail") {
            await requeueEvent(thread, item, { clearCodexSession: resumed });
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
            await this.postThreadReply(thread, event, result.sessionId, (result.parsed as PermissionRequiredOutput).text);
            await this.handlePermissionRequired(thread, event, result.parsed as PermissionRequiredOutput);
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

  private async notifyOwner(
    thread: ThreadHandle,
    event: UniversalEvent,
    request: SessionPermissionRequest,
  ): Promise<SourceMessageAnchor | null> {
    const ownerId = this.cfg.MATTERMOST_OWNER_USER_ID;
    if (!ownerId) {
      log.warn("owner.missing", { thread_key: thread.state.thread_key });
      return null;
    }
    const adapter = this.requireAdapter(event.source);
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
    await queueThreadEvent(outcome.thread, {
      received_at: outcome.at,
      event_file: outcome.decisionFile,
      source_event_id: `owner-${decision.mode === "reject" ? "reject" : "approve"}-${outcome.at}`,
    });
    await this.processThread(outcome.thread);
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

  private isOwnMattermostMessage(event: UniversalEvent): boolean {
    return isOwnMattermostMessage(event, this.cfg.MATTERMOST_BOT_USER_ID);
  }

}

export function namespacePermissions(skillId: string, permissions: string[]): string[] {
  return permissions.map((p) => (p.includes(":") ? p : `${skillId}:${p}`));
}
