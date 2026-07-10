# LLM-embedded owner mention, not a code-side deterministic ping

When a channel has a platform owner configured, Felix should @mention that owner in-channel alongside the existing DM notification when an approval goes pending. We chose to have the LLM embed the mention itself — via a conditional instruction appended to `SourceTurnContext.behaviorInstructions` (per-adapter, in `getTurnContext`) telling it to weave the exact mention token into its `FELIX_REPLY` when it emits `PERMISSION_REQUIRED` — rather than having Felix's own code deterministically post a separate ping after `requestPermission` runs.

## Considered Options

- **Code-side deterministic ping** — `requestPermission` (`src/slices/approvals/lifecycle.ts`) posts a fixed mention line via a new adapter method after the harness turn completes. Rejected: the owner explicitly preferred a single natural message over a second mechanical one, accepting the reliability trade-off below.
- **Code-side text, LLM-side WhatsApp tool call (hybrid)** — deterministic mention text for Discord/Slack/Mattermost, code-side only for WhatsApp since it needs a `--mention` CLI flag rather than text. Rejected in favor of a uniform mechanism across all four adapters.

## Consequences

- Whether the owner actually gets mentioned now depends on model compliance with a prompt instruction, not a code branch. There is no code-side guarantee, and no observability into misses (per explicit decision — no `owner.mention_missing`-style log was added).
- This is a deliberate deviation from this repo's general pattern of keeping reliability-critical behavior in the pure, deterministic core (e.g. `decideTurnResult`, routing predicates) rather than in generated text.
- WhatsApp's mention isn't text embedding at all — the LLM must issue its own `wacli send text --mention <jid>` tool call, mirroring the existing group-mention pattern, since WhatsApp requires the `--mention` flag to actually notify.
- The mention-instruction line is built per-adapter from that platform's *own* owner config (independent of `OWNER_CHANNEL`, which only redirects the DM target), and is omitted entirely when that platform's owner var is unset — so the LLM has nothing to fabricate a mention from when no owner is configured.
