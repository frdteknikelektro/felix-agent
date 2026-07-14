import type { UniversalEvent } from "../types.js";

/**
 * Returns true when an incoming event should be accepted for processing.
 * DMs are always accepted. Channel posts always require an explicit bot mention.
 * A thread marked `blocked` rejects every event (DMs included) — DMs are threads too.
 */
export function shouldAcceptEvent(
  event: UniversalEvent,
  thread?: { managed_by_felix: boolean; blocked?: boolean },
): boolean {
  if (event.visibility === "dm" && !thread?.blocked) return true;
  if (event.mentions_bot && !thread?.blocked) return true;
  if (thread?.managed_by_felix && !thread.blocked) return true;
  return false;
}

/**
 * Returns true when the event was sent by the bot itself, identified by
 * botUserId and source. Only the exact `source:id` compound form is treated
 * as self; other prefixes may mark human/system roles such as WhatsApp's
 * shared-number `owner:<jid>` sender.
 */
export function isOwnMessage(event: UniversalEvent, source: string, botUserId?: string): boolean {
  if (event.source !== source) return false;
  if (!botUserId) return false;
  return event.sender.id === botUserId || event.sender.id === `${source}:${botUserId}`;
}
