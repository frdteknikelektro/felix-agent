import type { SourceSender, SourceThreadRef, UniversalAttachment, UniversalEvent } from "../types.js";

export interface SourceThreadIdentityInput {
  source: string;
  conversationId: string;
  rootMessageId: string;
  messageId: string;
  sourceTeamId?: string;
  raw?: Record<string, unknown>;
}

export interface SourceEventNormalizationInput {
  source: string;
  eventId: string;
  receivedAt: string;
  visibility: UniversalEvent["visibility"];
  mentionsBot: boolean;
  sender: SourceSender;
  text: string;
  thread: SourceThreadIdentityInput;
  attachments?: UniversalAttachment[];
  rawPath?: string;
}

export function sourceThreadKey(
  source: string,
  conversationId: string,
  rootMessageId: string,
): string {
  return `${source}:${conversationId}:${rootMessageId}`;
}

export function sourceThreadRef(input: SourceThreadIdentityInput): SourceThreadRef {
  const ref: SourceThreadRef = {
    source: input.source,
    conversation_id: input.conversationId,
    thread_id: input.rootMessageId,
    root_message_id: input.rootMessageId,
    message_id: input.messageId,
  };
  if (input.sourceTeamId !== undefined) {
    ref.team_id = input.sourceTeamId;
  }
  if (input.raw !== undefined) {
    ref.raw = input.raw;
  }
  return ref;
}

export function normalizeSourceEvent(input: SourceEventNormalizationInput): UniversalEvent {
  return {
    source: input.source,
    event_id: input.eventId,
    thread_key: sourceThreadKey(input.source, input.thread.conversationId, input.thread.rootMessageId),
    received_at: input.receivedAt,
    visibility: input.visibility,
    mentions_bot: input.mentionsBot,
    sender: input.sender,
    text: input.text,
    attachments: input.attachments ?? [],
    raw_path: input.rawPath ?? "",
    source_thread_ref: sourceThreadRef(input.thread),
  };
}
