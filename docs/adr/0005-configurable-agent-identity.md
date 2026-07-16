# Configurable agent identity

## Status

Accepted

## Context

Felix previously had no single configured name. Runtime fallbacks were hardcoded as `Felix` or `felix`, while some source adapters had separate identity settings. That made the first-run experience incomplete and caused custom deployments to present inconsistent names when a platform identity was unavailable.

## Decision

Add a required `FELIX_NAME` prompt as the first step of the setup wizard. Persist it in `.env`, default it to `Felix` for existing installations, and use it for runtime-visible fallback identity and harness decision-notification prompts.

Source identities discovered from authenticated platform APIs remain authoritative. Mattermost owner profile details are derived from the configured owner ID at runtime, while WhatsApp uses `FELIX_NAME` directly instead of exposing a second name override.

## Consequences

- New customers choose the agent name before configuring providers.
- Existing `.env` files continue to boot unchanged.
- Telegram, Mattermost fallback mentions, WhatsApp formatting, and decision notifications use the configured name.
- Product branding and internal identifiers remain `Felix`; this setting controls the agent’s customer-facing identity.
