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
  if (thread?.blocked) return false;
  if (event.visibility === "dm") return true;
  if (event.mentions_bot) return true;
  if (thread?.managed_by_felix) return true;
  return false;
}

/**
 * Returns true when the event was sent by the bot itself, identified by
 * botUserId and source. Only the exact `source:id` compound form is treated
 * as self; other prefixes may mark human/system roles such as WhatsApp's
 * shared-number `owner:<jid>` sender.
 */
export function isOwnMessage(
  event: UniversalEvent,
  source: string,
  botUserId?: string,
): boolean {
  if (event.source !== source) return false;
  if (!botUserId) return false;
  return (
    event.sender.id === botUserId ||
    event.sender.id === `${source}:${botUserId}`
  );
}

/**
 * Returns true when the event was sent by the configured Owner for this
 * source. Symmetric to `isOwnMessage` — the engine uses it to gate owner-only
 * commands like `/block` and `/unblock`. When `ownerUserId` is unset the
 * owner identity is unknown and the check returns false (closed by default).
 */
export function isOwnerMessage(
  event: UniversalEvent,
  source: string,
  ownerUserId?: string,
): boolean {
  if (event.source !== source) return false;
  if (!ownerUserId) return false;
  return (
    event.sender.id === ownerUserId ||
    event.sender.id === `${source}:${ownerUserId}` ||
    event.sender.id === `owner:${ownerUserId}`
  );
}
