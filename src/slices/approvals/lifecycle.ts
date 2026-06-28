import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import type { DecisionNotificationInput, PermissionRequiredOutput, SourceAdapter } from "../../core/ports.js";
import { fallbackNotification } from "../../core/harness-common.js";
import { log } from "../../lib/log.js";
import { fsTimestamp } from "../../lib/time.js";
import type { OwnerDecision, SessionPermissionRequest, SourceMessageAnchor, UniversalEvent } from "../../types.js";
import {
  appendEventToThread,
  appendFelixReply,
  queueThreadEvent,
  type ThreadHandle,
} from "../sessions/index.js";
import { applyOwnerDecision as applyOwnerDecisionRecord } from "./apply.js";
import { requestApproval, type ApprovalRecord } from "./registry.js";

type ApprovalSourceAdapter = Pick<
  SourceAdapter,
  | "ownerUserId"
  | "getThreadLink"
  | "formatOwnerNotification"
  | "sendUserMessage"
  | "editUserMessage"
  | "sendThreadReply"
  | "updateEventStatus"
>;

export interface ApprovalRequestLifecyclePorts {
  sourceAdapter(source: string): ApprovalSourceAdapter;
  generateDecisionNotification?(input: DecisionNotificationInput): Promise<string | undefined>;
  ownerDisplayForSource?(source: string): string | undefined;
  warn?(message: string, data: Record<string, unknown>): void;
}

export type ApplyOwnerDecisionLifecycleResult =
  | { kind: "not_found" }
  | { kind: "applied"; thread: ThreadHandle; shouldProcess: boolean };

export class ApprovalRequestLifecycle {
  constructor(
    private readonly cfg: AppConfig,
    private readonly ports: ApprovalRequestLifecyclePorts,
  ) {}

  async requestPermission(input: {
    thread: ThreadHandle;
    event: UniversalEvent;
    parsed: PermissionRequiredOutput;
  }): Promise<void> {
    const { thread, event, parsed } = input;
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
      this.warn("owner.notify_undelivered", {
        thread_key: thread.state.thread_key,
        request_id: request.request_id,
        skill_id: request.skill_id,
      });
    }

    await requestApproval(this.cfg, thread, request);
    await this.ports.sourceAdapter(event.source).updateEventStatus({ event, status: "permission_required" });
  }

  async autoGrantPermission(input: {
    thread: ThreadHandle;
    event: UniversalEvent;
    sessionId: string;
  }): Promise<void> {
    const { thread, event, sessionId } = input;
    const adapter = this.ports.sourceAdapter(event.source);
    const text = fallbackNotification("once");
    await adapter.sendThreadReply({ event, text });
    await adapter.updateEventStatus({ event, status: "replied" });
    await appendFelixReply(thread, new Date().toISOString(), text, sessionId);
    await this.queueProceedEvent(thread);
  }

  async applyOwnerDecision(decision: OwnerDecision): Promise<ApplyOwnerDecisionLifecycleResult> {
    const outcome = await applyOwnerDecisionRecord(this.cfg, decision);
    if (!outcome) return { kind: "not_found" };

    if (outcome.record) {
      await this.updateOwnerDecisionMessage(outcome.thread, outcome.record, decision.mode);
    }

    const notification = await this.ports.generateDecisionNotification?.({
      thread: outcome.thread,
      mode: decision.mode,
      skillId: outcome.record?.skillId ?? "(unknown)",
      reason: outcome.record?.reason ?? "",
      ownerDisplay: this.ports.ownerDisplayForSource?.(outcome.thread.state.source),
    });
    if (notification) {
      await this.postDecisionNotification(outcome.thread, notification);
    }

    if (decision.mode !== "reject") {
      await this.queueProceedEvent(outcome.thread);
    }
    return { kind: "applied", thread: outcome.thread, shouldProcess: true };
  }

  private async notifyOwner(
    thread: ThreadHandle,
    event: UniversalEvent,
    request: SessionPermissionRequest,
  ): Promise<SourceMessageAnchor | null> {
    const targetSource = this.cfg.OWNER_CHANNEL ?? event.source;
    const adapter = this.ports.sourceAdapter(targetSource);
    const ownerId = adapter.ownerUserId;
    if (!ownerId) {
      this.warn("owner.missing", { source: targetSource, thread_key: thread.state.thread_key });
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
      this.warn("owner.notify_failed", {
        thread_key: thread.state.thread_key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async postDecisionNotification(thread: ThreadHandle, text: string): Promise<void> {
    const source = thread.state.source;
    const ref = thread.state.source_thread_ref;
    try {
      const adapter = this.ports.sourceAdapter(source);
      if (!ref) {
        this.warn("thread.no_source_thread_ref", {
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
      this.warn("thread.decision_notify_post_failed", {
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
    const adapter = this.ports.sourceAdapter(targetSource);
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
      this.warn("owner.edit_notification_failed", {
        thread_key: thread.state.thread_key,
        source: thread.state.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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

  private warn(message: string, data: Record<string, unknown>): void {
    (this.ports.warn ?? log.warn)(message, data);
  }
}

export function namespacePermissions(skillId: string, permissions: string[]): string[] {
  return permissions.map((p) => (p.includes(":") ? p : `${skillId}:${p}`));
}
