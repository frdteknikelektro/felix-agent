import type { UniversalAttachment, UniversalEvent } from "./types.js";

export interface SourceAdapter {
  source: string;
  getThreadLink(threadKey: string): string | undefined;
  sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void>;
  sendUserMessage(input: { userId: string; text: string }): Promise<{ post_id: string; channel_id: string } | null>;
  addReaction(input: { event: UniversalEvent; emoji: string }): Promise<void>;
  removeReaction(input: { event: UniversalEvent; emoji: string }): Promise<void>;
  downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
  }): Promise<UniversalAttachment>;
}
