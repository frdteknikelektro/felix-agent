# Configurable agent identity

## Status

Accepted

## Context

Felix previously had no single configured name. Runtime fallbacks were hardcoded as `Felix` or `felix`, while some source adapters had separate identity settings. That made the first-run experience incomplete and caused custom deployments to present inconsistent names when a platform identity was unavailable.

## Decision

Add a required `FELIX_NAME` prompt as the first step of the setup wizard. Persist it in `.env`, default it to `Felix` for existing installations, and use it for runtime-visible fallback identity and harness decision-notification prompts.

Source-specific identities remain authoritative when configured. In particular, Mattermost username/display and WhatsApp bot name continue to control platform mention behavior; `FELIX_NAME` is the fallback rather than a replacement for those settings.

## Consequences

- New customers choose the agent name before configuring providers.
- Existing `.env` files continue to boot unchanged.
- Telegram, Mattermost fallback mentions, WhatsApp fallback formatting, and decision notifications use the configured name.
- Product branding and internal identifiers remain `Felix`; this setting controls the agent’s customer-facing identity.
