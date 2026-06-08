import type { UniversalEvent } from "../types.js";

/**
 * Returns true when an incoming event should be accepted for processing.
 * DMs are always accepted. Channel posts require an explicit bot mention,
 * unless the event is a reply in a thread already managed by Felix.
 */
export function shouldAcceptEvent(
  event: UniversalEvent,
  thread?: { managed_by_felix: boolean },
): boolean {
  if (event.visibility === "dm") return true;
  if (event.mentions_bot) return true;
  if (thread?.managed_by_felix) return true;
  return false;
}

/**
 * Returns true when the event was sent by the bot itself, identified by
 * botUserId. The `source:id` compound form handles cases where the adapter
 * prefixes the source name.
 */
export function isOwnMattermostMessage(event: UniversalEvent, botUserId?: string): boolean {
  if (event.source !== "mattermost") return false;
  if (!botUserId) return false;
  return event.sender.id === botUserId || event.sender.id.endsWith(`:${botUserId}`);
}
