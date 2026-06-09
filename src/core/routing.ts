import type { UniversalEvent } from "../types.js";

/**
 * Returns true when an incoming event should be accepted for processing.
 * DMs are always accepted. Channel posts always require an explicit bot mention.
 */
export function shouldAcceptEvent(
  event: UniversalEvent,
  _thread?: { managed_by_felix: boolean },
): boolean {
  if (event.visibility === "dm") return true;
  if (event.mentions_bot) return true;
  return false;
}

/**
 * Returns true when the event was sent by the bot itself, identified by
 * botUserId and source. The `source:id` compound form handles cases where
 * the adapter prefixes the source name.
 */
export function isOwnMessage(event: UniversalEvent, source: string, botUserId?: string): boolean {
  if (event.source !== source) return false;
  if (!botUserId) return false;
  return event.sender.id === botUserId || event.sender.id.endsWith(`:${botUserId}`);
}
