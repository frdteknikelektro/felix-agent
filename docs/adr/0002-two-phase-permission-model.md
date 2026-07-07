# Two-phase permission model

Database permissions use a two-phase model: base permissions declared in SKILL.md frontmatter (`read`, `write`, `admin`), plus connection-specific permissions resolved by the LLM at runtime (e.g., `database:read.prod-pg`, `database:write.staging-*`).

Phase 1 is server-computed: the engine compares declared permissions against the contact's `allowed_permissions` and injects `permissions_per_skill` into the prompt. Phase 2 is skill-resolved: the SKILL.md instructs the LLM to additionally check connection-specific permissions from the contact file, using wildcard matching (`database:read.*` matches `database:read.prod-pg`).

When a connection-specific permission is missing, the LLM emits `PERMISSION_REQUIRED` with the exact permission needed. The owner approves, `grantPermissions()` adds it to the contact, and future operations on that connection are pre-authorized.

## Considered Options

- **Server-side dynamic permissions** — the server resolves connection-specific permissions before injecting `permissions_per_skill`. Rejected because connections are dynamic (added at runtime) and the server can't know which connection the user will ask about.
- **Flat permission per operation** — `database:select`, `database:insert`, `database:update` without connection scoping. Rejected because it doesn't support per-connection trust (prod read-only, staging full access).
- **Single permission with connection in body** — `database:access` with the connection name in the PERMISSION_REQUIRED body. Rejected because it loses thegranularity the owner needs to grant selective access.

## Consequences

- Owners can grant fine-grained access: `database:read.prod-pg` (read-only prod), `database:write.staging-*` (write all staging), `database:admin.analytics` (full admin on analytics).
- Wildcard matching is a skill-level convention, not a server feature — the LLM must follow the SKILL.md instructions.
- The contact's `allowed_permissions` list may grow with per-connection entries, but each is a short string.
- No changes to the core permission infrastructure — `grantPermissions()` already accepts arbitrary strings.
