---
id: posthog-jala
name: PostHog Jala Management
description: Jala-specific PostHog analytics management. Extends the base posthog skill — all operations, permission policy, destructive gating, and API patterns are identical. The only difference is the credential (POSTHOG_JALA_PERSONAL_KEY) and the Jala org/project context (orgs 10590 and 28053).
version: 1
enabled: true
kind: operational
permissions:
  - posthog.read
  - posthog.write
match:
  - posthog jala
  - jala posthog
  - jala analytics
  - jala event
  - jala feature flag
  - jala dashboard
  - jala insight
  - jala cohort
  - jala session
  - jala capture
  - jala hogql
  - jala survey
  - jala experiment
---

# PostHog Jala Management

## Purpose
Operate Jala's PostHog analytics through the REST API. This skill extends the base `posthog` skill. Every operation, permission policy, destructive-operation gate, and API pattern is identical — read `skills/posthog/SKILL.md` for the full reference. This skill only overrides the credential contract, the Jala organization/project context, and qualified match rules.

**Jala organizations**:
- **Jala** — org ID `10590`
- **Jala Widget** — org ID `28053`

The Jala personal key (`POSTHOG_JALA_PERSONAL_KEY`) has access to both organizations. Detailed project listings are in `references/jala-context.md`.

Do not duplicate operation documentation. If you need the full operation reference for a PostHog operation, read the base `posthog` SKILL.md. This file documents only what is different.

## Permission Policy
Same text-based read/write split as the base `posthog` skill, namespaced under `posthog-jala`:

- `posthog-jala:posthog.read` — inspection, listing, viewing, searching, querying, downloads (same scope as base).
- `posthog-jala:posthog.write` — create, update, delete, toggle, launch, patch (same scope as base).

If an operation is ambiguous, treat it as `posthog-jala:posthog.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks — same gating as the base skill.

## Environment (overrides base)
Tokens are already in the environment. The Jala org uses its own API keys:

- `POSTHOG_JALA_PERSONAL_KEY` — Jala-specific private API key for management CRUD (prefix `phx_`)
- `POSTHOG_JALA_PROJECT_KEY` — Jala-specific project key (only for capture endpoints, optional)

Credential mapping pattern:

```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"
test -n "$POSTHOG_JALA_PROJECT_KEY" && export POSTHOG_PROJECT_KEY="$POSTHOG_JALA_PROJECT_KEY"
```

Verify the Jala key before any work:

```bash
test -n "$POSTHOG_JALA_PERSONAL_KEY" &&
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY" &&
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/users/@me/"
```

Note: the base `posthog` skill reads `POSTHOG_PERSONAL_KEY` from the environment. The Jala value is mapped in: `POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"`. Never print the key value.

## Permissions FIRST
Before doing anything else — before running any API call — resolve permissions. If permission is missing, emit PERMISSION_REQUIRED. Never skip this. The only gate in this skill is the permission gate.

## Jala Organization & Project Context
When the user does not specify which organization or project, default to the Jala orgs:

1. **List Jala projects**: Query projects from both orgs:
   ```bash
   curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
     "https://app.posthog.com/api/organizations/10590/projects/"
   ```
   and
   ```bash
   curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
     "https://app.posthog.com/api/organizations/28053/projects/"
   ```

2. **If the user names a project**, match by name across both orgs. If there's ambiguity (same name in both orgs), list both and ask which one.

3. **Fall back** to `GET /api/projects/` for the full list if the org-scoped listing is insufficient.

4. **Consult `references/jala-context.md`** for known project IDs and naming conventions. This file is best-effort — if a project ID returns 404, re-list projects via API to get the current state.

5. Once `project_id` is confirmed, cache it for the current session (do not re-ask).

When listing projects, include the org name so the user can disambiguate between Jala and Jala Widget.

## Operations
All operations are identical to the base `posthog` skill. Read `skills/posthog/SKILL.md` for the full operation reference covering Events, Feature Flags, Insights, Dashboards, Persons, Cohorts, Annotations, Surveys, Experiments, Session Recordings, HogQL Queries, Schema & Taxonomy, and Groups.

Every `curl` command must map `POSTHOG_JALA_PERSONAL_KEY` → `POSTHOG_PERSONAL_KEY`.

## Quick Examples
Every example maps `POSTHOG_JALA_PERSONAL_KEY` to `POSTHOG_PERSONAL_KEY`.

### Verify Jala auth
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/users/@me/"
```

### List Jala projects across both orgs
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"
echo "=== Jala (10590) ==="
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/10590/projects/" | python3 -c "import json,sys; [print(f'  {p[\"id\"]:>6}  {p[\"name\"]}') for p in json.load(sys.stdin).get('results',[])]"
echo "=== Jala Widget (28053) ==="
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/28053/projects/" | python3 -c "import json,sys; [print(f'  {p[\"id\"]:>6}  {p[\"name\"]}') for p in json.load(sys.stdin).get('results',[])]"
```

### Query Jala events from yesterday
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"
curl -s -G \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  --data-urlencode 'after=-1d' \
  --data-urlencode 'limit=10' \
  "https://app.posthog.com/api/projects/{project_id}/events/"
```

### List Jala feature flags
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/" | python3 -c "import json,sys; [print(f'{f[\"id\"]:>6}  {f[\"key\"]:<35}  active={f[\"active\"]}') for f in json.load(sys.stdin).get('results',[])]"
```

### Create Jala feature flag
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"new_feature","name":"New Feature","active":false,"filters":{"groups":[{"properties":[],"rollout_percentage":0}]}}' \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/"
```

### Query Jala events with time range
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"
curl -s -G \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  --data-urlencode 'after=2024-06-01T00:00:00Z' \
  --data-urlencode 'before=2024-06-02T00:00:00Z' \
  --data-urlencode 'event=$pageview' \
  --data-urlencode 'limit=50' \
  "https://app.posthog.com/api/projects/{project_id}/events/"
```

## Output
Same as base `posthog` skill. Keep replies concise and operational. Include project name, ID, and relevant counts. Never print `POSTHOG_JALA_PERSONAL_KEY`, `POSTHOG_PERSONAL_KEY`, or any credential value.

## Checks
- Always map `POSTHOG_JALA_PERSONAL_KEY` → `POSTHOG_PERSONAL_KEY` before any API call.
- Always verify the key with `GET /api/users/@me/` before doing real work.
- Never print `POSTHOG_JALA_PERSONAL_KEY` or any credential value.
- For project-scoped operations, default to Jala orgs (10590, 28053) when the user doesn't specify.
- Read `skills/posthog/SKILL.md` for any operation not documented here.
- Read `references/jala-context.md` for Jala org/project details — but verify with API if a reference ID returns 404.
- Destructive operations must be explicitly requested by the user before proceeding.
- Tokens are in the environment
