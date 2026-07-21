# ADR 0013: Claude Code subscription OAuth via captured setup-token output

## Status

Accepted for Felix 0.1.1.

## Decision

Claude Code supports authenticating with a Claude Pro/Max/Team subscription
via `claude setup-token`, which mints a long-lived OAuth token
(`sk-ant-oat01-...`) and prints it to the terminal — unlike Codex's
`--device-auth`, it writes no file we can read back. Setup spawns
`claude setup-token` with stdout split (`stdio: ["inherit", "pipe", "inherit"]`):
each chunk is forwarded live so the browser-auth prompt still displays, while
also buffered so the token can be regex-extracted (`sk-ant-oat01-[A-Za-z0-9_-]+`)
once the process exits. On failure, or if the pattern isn't found, setup falls
back to the existing `ANTHROPIC_API_KEY` prompt — mirroring Codex's OAuth
fallback exactly.

The token is stored as `CLAUDE_CODE_OAUTH_TOKEN`. Because Claude Code's own
credential precedence ranks `ANTHROPIC_API_KEY` above it, setup explicitly
clears `ANTHROPIC_API_KEY` on successful OAuth login so the new token actually
takes effect, the same guard Codex already applies to `OPENAI_API_KEY` after a
successful `--device-auth` login.

## Consequences

Model-list validation against `api.anthropic.com/v1/models` must branch on
credential type: `x-api-key` for a plain API key, but `Authorization: Bearer`
plus the `anthropic-beta: oauth-2025-04-20` header for the OAuth token — the
two are not interchangeable, and sending the OAuth token as `x-api-key`
returns 401. If `claude setup-token`'s output format changes in a future CLI
release, the capture regex may stop matching; the failure mode is a clean
fallback to the API-key prompt, not a hang or crash.
