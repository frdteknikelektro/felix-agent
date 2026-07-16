# ADR 0009: Friendly owner identification

## Status

Accepted for Felix 0.1.1.

## Decision

Authorization continues to use immutable platform user IDs or WhatsApp JIDs,
but first-time setup no longer asks users to find those identifiers by default.
Mattermost resolves a supplied username, Discord and Slack temporarily connect
and accept an exact one-time code from a human direct message, WhatsApp
normalizes an international phone number, and Telegram keeps its authenticated
private-message claim.

All source flows share one setup owner-discovery interface. Existing IDs are
preserved by default. A failed automatic attempt offers retry, validated manual
ID entry, or cancellation. Temporary clients, timers, and listeners are cleaned
up, and setup does not replace `.env` until the final atomic write.

Legacy owner username/display settings remain parseable for upgrades, but new
setup does not write them. Mattermost, Discord, and Slack derive presentation
data from authenticated runtime APIs and fall back to `Owner`.

## Consequences

Customers normally provide a username, direct message, or phone number instead
of copying an opaque ID. Authorization remains stable when display names or
usernames change. Discord claims require DMs, Slack claims require Socket Mode
and `message.im`, and Telegram claims require an inactive bot with no registered
webhook.
