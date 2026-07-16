# ADR 0007: API-derived identities and Telegram transport modes

## Status

Accepted for Felix 0.1.1.

## Decision

Bot identities are runtime facts, not setup-owned configuration. Mattermost
uses `/api/v4/users/me`, Discord uses `client.user`, Slack uses `auth.test`,
Telegram uses `getMe`, and WhatsApp uses the paired JID returned by `wacli
doctor --json`. Legacy bot identity environment variables remain parseable;
Mattermost, Discord, and Slack may use them when discovery is unavailable.
Telegram requires `getMe` and does not start from its legacy ID. Human owner
authorization remains based on stable IDs or JIDs. Setup discovers those values
from friendlier inputs: Mattermost username lookup, Discord/Slack/Telegram
private-message claims, and WhatsApp phone normalization. Runtime APIs derive
owner presentation data where supported. `FELIX_NAME` is the human-facing
fallback and the single WhatsApp presentation name.

Telegram explicitly supports `polling` (the default) and `webhook`. Polling
uses `getUpdates` and removes a stale webhook. Webhook mode requires an HTTPS
URL and secret, registers the URL with `setWebhook`, validates Telegram's
secret-token header, and removes the registered webhook during shutdown.

## Consequences

New setup is shorter and identity drift is reduced. Existing non-Telegram `.env`
files keep booting; Telegram installations require API availability during
startup. Webhook deployments need customer-managed HTTPS and a secret, while
polling remains suitable for private hosts without public ingress.
The Telegram claim refuses to take over a registered webhook. Existing owner
identifiers are preserved by default on later setup runs, and manual ID entry is
offered only after automatic discovery fails.
