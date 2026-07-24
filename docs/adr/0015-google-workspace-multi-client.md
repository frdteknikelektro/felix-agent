# ADR 0015: Google Workspace second account via a bundled `work` client skill

## Status

Accepted for Felix 0.1.1.

## Context

The `gog` CLI isolates credentials and refresh tokens per **OAuth client** (a
distinct credential + token bucket, selected with `--client <name>`). Felix
shipped only the `default` client: `import-credentials.mjs` and the setup gog
block were hardcoded to it, and no runtime command passed `--client`. A user
with a second, separate Google Cloud project (e.g. a work account) had no
supported way to authorize or reach it.

Unlike a CLI authenticated by a token env var — where a second account is just
another variable to re-export — Google auth is a persistent OAuth grant in the
keyring, not an env var. So a second account genuinely needs both its own
credentials *and* an interactive login step, and that login needs a persistent
terminal the chat harness lacks (see the setup gog flow added alongside this ADR).

## Decision

Ship a second **bundled** skill, `google-workspace-work`, backed by the `gog`
`work` client, rather than a separately-deployed skill. Bundling keeps all
gog-touching code inside the reviewed image (gog is already the sanctioned image
runtime boundary) and avoids any need for setup to execute scripts shipped by
skills deployed outside the image.

- **Isolation is the skill id.** `google-workspace-work` is its own permission
  namespace; a `google-workspace-work:*` grant never authorizes the base
  `google-workspace` skill or vice versa. The `work` client's credentials and
  tokens are physically separate in the gog store. This is why it is a distinct
  skill and not a multi-client mode of the base skill — the permission grammar
  (`{skill}:{action}.{service}`) has no client slot, so one skill id could not
  express per-client isolation.
- **Symmetric env storage, `--expand-env` preserved.** The work client declares
  `GOOGLE_WORK_CLIENT_ID` / `GOOGLE_WORK_CLIENT_SECRET`, mirroring the default
  client's `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Each client's stored
  credential template references its **own** env-var names, so the secret stays
  in `.env` (never a workspace file), regardless of whether `--expand-env`
  resolves at store time or at runtime. `GOG_HOME` and `GOG_KEYRING_PASSWORD`
  are shared — one encrypted store holds every client's data.
- **Client-parametrized setup.** The setup gog logic is refactored into one
  `authorizeGogClient({ spec })` helper driven by a per-client spec (client
  name + the two env-var names); setup calls it in a separate branch per
  bundled Google skill (`google-workspace` → `default`,
  `google-workspace-work` → `work`). `import-credentials.mjs` gains
  `--client` / `--id-env` / `--secret-env` (defaulting to the original
  `default` behavior for backward compatibility).
- **Runtime routing is explicit `--client work`.** The overlay's SKILL.md
  requires every command to pass `--client work`; no domain auto-map is assumed,
  so it works for any address, not only a distinct work domain.

## Consequences

Adding a third client is a new bundled skill plus one more setup branch (or a
future lift of the two branches into a spec table) — not a schema change. The
`work` name matches gog's own `--client work` docs example and is generic, so an
organization- or context-specific second account simply uses the `work` client
rather than getting its own skill. Because authorization runs before `.env` is
written,
abandoning the review after authorizing orphans the keyring (its password is
unsaved); setup warns in that case, and re-running setup re-authorizes cleanly.
The `--client`, `credentials set --client`, and `--expand-env` behaviors are
verified against the image's pinned gog (0.34.0) at build time.
