---
id: posthog
name: PostHog Analytics Management
description: Full PostHog management via REST API — events, feature flags, insights, dashboards, persons, cohorts, annotations, surveys, experiments, session recordings, HogQL queries, and taxonomy. Uses POSTHOG_PERSONAL_KEY (available in environment). Uses text-based read/write permission guidance.
version: 1
enabled: true
kind: operational
permissions:
  - posthog.read
  - posthog.write
match:
  - posthog
  - feature flag
  - feature flags
  - feature toggle
  - hogql
  - session replay
  - session replays
  - posthog event
  - posthog events
  - posthog analytics
  - posthog dashboard
  - posthog insight
  - posthog cohort
  - posthog survey
  - posthog experiment
  - posthog person
  - posthog capture
---

# PostHog Analytics Management

## Purpose
Operate PostHog through the REST API using `curl`. This skill covers events, feature flags, insights, dashboards, persons, cohorts, annotations, surveys, experiments, session recordings, HogQL queries, and schema management. It is generic — no default project or organization.

The PostHog REST API is comprehensive (100% feature parity with the UI). There is no mature CLI — all operations use `curl` with Bearer token auth against `https://app.posthog.com/api`.

Use text-based permission judgment. Do not add or rely on hardcoded TypeScript command detection for PostHog read/write classification.

## Permission Policy
Use the requested intent and the likely PostHog effect to choose the required permission:

- `posthog:posthog.read` — inspection, listing, viewing, searching, querying, downloading exports. Examples: list projects, list organizations, view insight, get feature flag, list events, query person, run HogQL query, list session recordings, get dashboard, view annotation, list cohorts, view survey, get experiment results, list event definitions, list property definitions.
- `posthog:posthog.write` — creating, updating, or deleting anything in PostHog. Examples: create feature flag, toggle flag, update cohort, delete dashboard, capture event, create insight, patch person properties, set annotation, launch experiment, create survey.

If an operation is ambiguous, treat it as `posthog:posthog.write` unless the user is only asking to inspect or explain current state.

**HogQL queries are `posthog:posthog.read`** — they are analytical read-only operations (the POST method is an API quirk, not a write indicator). Warn if the HogQL query targets person properties that may contain PII.

**Destructive operations** are allowed only when the user explicitly asks for the specific destructive intent: `DELETE` on feature flags, insights, dashboards, cohorts, surveys, experiments, annotations, or persons. These must be explicitly named by the user — never infer deletion.

## Environment
Use tokens from the environment before every PostHog API call. Do not use credential files.

Required variable:
- `POSTHOG_PERSONAL_KEY` — private API key for management CRUD (prefix `phx_`)

Optional variable:
- `POSTHOG_PROJECT_KEY` — only for public endpoints (`/i/v0/e/` capture, `/decide/` flag eval)

Command pattern:

```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
```

Verify the key is valid before any PostHog work:

```bash
test -n "$POSTHOG_PERSONAL_KEY" &&
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY" &&
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/users/@me/"
```

If the response is not `200`, check that `POSTHOG_PERSONAL_KEY` is set, valid, and has the correct `phx_` prefix. Never print the key value.

API base URL: `https://app.posthog.com`
All requests use: `-H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" -H "Content-Type: application/json"`

## Workflow
0. **Resolve permissions FIRST.** Before doing anything else — before running any API call — determine whether the user has permission for the requested work. If permission is missing, emit PERMISSION_REQUIRED. Never skip this step.
1. Classify the requested work as read or write using the permission policy above.
2. export `POSTHOG_PERSONAL_KEY`, and verify with `GET /api/users/@me/`. If the key is invalid, report it and stop.
3. Discover the project context. Most endpoints require a `project_id` in the URL. Never guess a project ID. List projects with `GET /api/projects/` and let the user confirm. Optionally scope by organization first with `GET /api/organizations/`.
4. Execute the operation. Include `-H "Authorization: Bearer $POSTHOG_PERSONAL_KEY"` and `-H "Content-Type: application/json"` on every request.
5. Report results concisely. Include project name, ID, relevant counts, and key values.
6. Follow cursor pagination automatically for small result sets (under ~500 items). For large sets, tell the user how many pages remain and ask if they want to continue.

## Operations

### Auth & Identity

**Verify current user** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/users/@me/"
```

Returns the authenticated user, their organizations, and project access. Use this as a smoke test before any work.

### Organizations

**List organizations** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/"
```

**Get organization detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/{org_id}/"
```

Returns org name, members, created date.

**List organization members** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/{org_id}/members/"
```

**List organization projects** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/{org_id}/projects/"
```

### Projects

**List all projects** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/"
```

Returns all projects across all organizations the key can access. Use this for project discovery.

**Get project detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/"
```

**Update project settings** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"New Name","is_demo":false}' \
  "https://app.posthog.com/api/projects/{project_id}/"
```

**Create project** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-project","organization_id":"{org_id}"}' \
  "https://app.posthog.com/api/projects/"
```

### Events

The Events API is the most commonly used operation. PostHog enforces a time window on all event queries.

#### Capture Events

**Capture single event** (`posthog:posthog.write`, uses `POSTHOG_PROJECT_KEY`):

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"api_key":"$POSTHOG_PROJECT_KEY","event":"user_signed_up","distinct_id":"user_123","properties":{"plan":"pro"}}' \
  "https://app.posthog.com/i/v0/e/"
```

**Capture batch events** (`posthog:posthog.write`, uses `POSTHOG_PROJECT_KEY`):

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"api_key":"$POSTHOG_PROJECT_KEY","batch":[{"event":"pageview","distinct_id":"user_1","properties":{}},{"event":"click","distinct_id":"user_2","properties":{}}]}' \
  "https://app.posthog.com/batch/"
```

The `POSTHOG_PROJECT_KEY` is a public token — rate limits do not apply to capture endpoints.

#### Query Events

**List events** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/events/?after=2024-01-01T00:00:00Z&before=2024-01-02T00:00:00Z"
```

Query parameters:

| Parameter | Format | Description |
|---|---|---|
| `after` | ISO 8601 or relative (`-7d`, `-24h`, `-30d`) | Start of time window (required) |
| `before` | ISO 8601 | End of time window (optional, defaults to now) |
| `event` | string | Filter by event name (e.g., `$pageview`, `user_signed_up`) |
| `properties` | URL-encoded JSON array | Property filters |
| `distinct_id` | string | Filter by distinct ID |
| `person_id` | UUID | Filter by person UUID |
| `orderBy` | field name | Sort (prefix with `-` for descending, e.g., `-timestamp`) |
| `limit` | integer | Results per page |
| `select` | comma-separated fields | Return only specific fields (timestamp, event, properties, person, distinct_id) |

**Property filter syntax** — passed as `?properties=...` (URL-encoded):

```json
[
  {"key":"$browser","operator":"exact","value":"Chrome","type":"event"},
  {"key":"plan","operator":"icontains","value":"pro","type":"event"}
]
```

Supported operators: `exact`, `iexact`, `icontains`, `regex`, `gt`, `gte`, `lt`, `lte`, `is_set`, `is_not_set`, `is_date_exact`, `is_date_after`, `is_date_before`. Combine filters with `AND` or `OR` by wrapping them.

**Time window is required**: If the user does not specify a time range, default to the last 7 days (`after=-7d`) and state this clearly in the response. Do not guess wider windows.

**Date handling**: Always use ISO 8601 format in UTC (`2024-01-15T00:00:00Z`). When the user says "yesterday", "last week", "last month", compute the equivalent ISO 8601 range. PostHog also supports relative shorthand: `-24h`, `-7d`, `-30d`, `-90d`.

**Pagination**: Response includes a `next` field with the cursor URL. Follow it to get subsequent pages:

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "{next_url_from_response}"
```

**Common PostHog events** (prefix `$` denotes internal events):
`$pageview`, `$pageleave`, `$autocapture`, `$identify`, `$feature_flag_called`, `$survey_shown`, `$survey_dismissed`, `$experiment_participation`

**Example — events with time and properties** (`posthog:posthog.read`):

```bash
curl -s -G \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  --data-urlencode 'after=2024-06-01T00:00:00Z' \
  --data-urlencode 'before=2024-06-02T00:00:00Z' \
  --data-urlencode 'event=$pageview' \
  --data-urlencode 'properties=[{"key":"$browser","operator":"exact","value":"Chrome","type":"event"}]' \
  --data-urlencode 'limit=50' \
  "https://app.posthog.com/api/projects/{project_id}/events/"
```

### Feature Flags

**List feature flags** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/"
```

**Get feature flag detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/{flag_id}/"
```

Returns key, name, active status, rollout percentage, filters, conditions.

**Create feature flag** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"new_checkout_flow","name":"New Checkout Flow","filters":{"groups":[{"properties":[],"rollout_percentage":0}]},"active":false}' \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/"
```

Flag key convention: lowercase, snake_case recommended. Keys are unique per project.

**Update feature flag** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"active":true,"filters":{"groups":[{"properties":[],"rollout_percentage":50}]}}' \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/{flag_id}/"
```

Flag changes are instant — there is no draft mode and no deployment gate. The permission check must be strict.

**Delete feature flag** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/{flag_id}/"
```

This is destructive. Only run when the user explicitly asks to delete a specific flag.

**Get flag activity** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/{flag_id}/activity/"
```

### Insights

**List insights** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/insights/"
```

**Get insight detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/insights/{insight_id}/"
```

Returns the full insight configuration including kind, filters, series, and result data.

Insight kinds:
- `TRENDS` — time-series charts of events or actions
- `FUNNELS` — conversion between ordered steps
- `RETENTION` — cohort-based retention analysis
- `PATHS` — user journey flow between pages/screens
- `LIFECYCLE` — new, returning, resurrecting, and dormant users
- `STICKINESS` — DAU/WAU/MAU or repeat usage metrics

**Create insight** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Insight","filters":{"events":[{"id":"$pageview","type":"events","name":"$pageview"}],"date_from":"-7d"},"saved":true}' \
  "https://app.posthog.com/api/projects/{project_id}/insights/"
```

Creating insights requires understanding the nested filter format. When the user wants to "create an insight like X", first GET an existing similar insight to understand the payload shape, then adapt it. Do not invent the filter structure from scratch.

**Update insight** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{...}' \
  "https://app.posthog.com/api/projects/{project_id}/insights/{insight_id}/"
```

**Delete insight** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/insights/{insight_id}/"
```

This is destructive. Only run when the user explicitly asks to delete a specific insight.

### Dashboards

**List dashboards** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/dashboards/"
```

**Get dashboard detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/dashboards/{dashboard_id}/"
```

Returns dashboard metadata and tiles (each tile references an insight).

**Create dashboard** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Product KPIs","description":"Key product metrics","tags":["product"]}' \
  "https://app.posthog.com/api/projects/{project_id}/dashboards/"
```

**Update dashboard** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"New Name","tiles":[...]}' \
  "https://app.posthog.com/api/projects/{project_id}/dashboards/{dashboard_id}/"
```

Tiles map insight IDs to layout coordinates.

**Delete dashboard** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/dashboards/{dashboard_id}/"
```

This is destructive. Only run when the user explicitly asks to delete a specific dashboard. Deleting a dashboard does not delete the underlying insights.

### Persons

**List persons** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/persons/"
```

Supports property filters: `?properties=[{"key":"email","operator":"exact","value":"user@example.com"}]` and search: `?search=query`.

**Get person profile** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/persons/{person_id}/"
```

Returns person properties, distinct IDs, and creation date.

**Get person events** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/persons/{person_id}/events/"
```

Returns all events for a specific person. Use for debugging user journeys.

**Update person properties** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"properties":{"plan":"enterprise"}}' \
  "https://app.posthog.com/api/projects/{project_id}/persons/{person_id}/"
```

**Delete person** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/persons/{person_id}/"
```

This deletes the person and all their events. Requires explicit user intent.

### Cohorts

**List cohorts** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/cohorts/"
```

**Get cohort detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/cohorts/{cohort_id}/"
```

**Create static cohort** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Beta Users","is_static":true}' \
  "https://app.posthog.com/api/projects/{project_id}/cohorts/"
```

**Create dynamic cohort** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Power Users","is_static":false,"filters":{"properties":{"type":"AND","values":[{"key":"signed_up","type":"person","value":"is_set","operator":"is_set"}]}}}' \
  "https://app.posthog.com/api/projects/{project_id}/cohorts/"
```

Dynamic cohorts recalculate periodically based on behavioral or property filters. Static cohorts use an explicit list of user IDs.

**Update cohort** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{...}' \
  "https://app.posthog.com/api/projects/{project_id}/cohorts/{cohort_id}/"
```

**Delete cohort** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/cohorts/{cohort_id}/"
```

### Annotations

**List annotations** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/annotations/?after=2024-01-01T00:00:00Z&before=2024-01-31T23:59:59Z"
```

**Get annotation detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/annotations/{annotation_id}/"
```

**Create annotation** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Deployed v2.3.0","date_marker":"2024-06-15T10:00:00Z","scope":"organization"}' \
  "https://app.posthog.com/api/projects/{project_id}/annotations/"
```

Scope can be `organization` (visible across all org projects, useful for deployments) or `project` (single project only).

**Update annotation** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Updated content"}' \
  "https://app.posthog.com/api/projects/{project_id}/annotations/{annotation_id}/"
```

**Delete annotation** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/annotations/{annotation_id}/"
```

### Surveys

**List surveys** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/surveys/"
```

**Get survey detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/surveys/{survey_id}/"
```

Returns questions, targeting rules, appearance config, schedule.

**Create survey** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"NPS Survey","description":"Net Promoter Score","type":"popover","questions":[{"type":"rating","question":"How likely are you to recommend?","scale":10}]}' \
  "https://app.posthog.com/api/projects/{project_id}/surveys/"
```

**Update survey** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{...}' \
  "https://app.posthog.com/api/projects/{project_id}/surveys/{survey_id}/"
```

**Delete survey** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/surveys/{survey_id}/"
```

**Get survey responses** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/surveys/{survey_id}/responses/"
```

### Experiments

**List experiments** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/experiments/"
```

**Get experiment detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/experiments/{experiment_id}/"
```

Returns name, feature flag key, metrics, variant configurations, exposure, and results (if available).

**Create experiment** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"New Checkout A/B Test","feature_flag_key":"new_checkout_flow","parameters":{"recommended_running_time":14,"minimum_detectable_effect":5}}' \
  "https://app.posthog.com/api/projects/{project_id}/experiments/"
```

Experiments require an existing feature flag. The referenced flag must exist in the same project before creating the experiment.

**Update experiment** (`posthog:posthog.write`):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{...}' \
  "https://app.posthog.com/api/projects/{project_id}/experiments/{experiment_id}/"
```

**Launch experiment** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/experiments/{experiment_id}/launch/"
```

**Get experiment results** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/experiments/{experiment_id}/results/"
```

**Delete experiment** (`posthog:posthog.write`, DESTRUCTIVE):

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/experiments/{experiment_id}/"
```

### Session Recordings

**List session recordings** (`posthog:posthog.read`):

```bash
curl -s -G \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  --data-urlencode 'date_from=2024-06-01T00:00:00Z' \
  --data-urlencode 'date_to=2024-06-02T00:00:00Z' \
  --data-urlencode 'duration_min=30' \
  "https://app.posthog.com/api/projects/{project_id}/session_recordings/"
```

Filtering options:
- `date_from` / `date_to` — time window (ISO 8601 required)
- `duration_min` / `duration_max` — session length in seconds
- `person_uuid` — filter by person
- `events` — filter by events that occurred during the session (URL-encoded JSON array)
- `properties` — filter by session properties (URL-encoded JSON array)

**Get recording detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/session_recordings/{recording_id}/"
```

Returns metadata: duration, click count, console log count, start/end URLs.

**List recording playlists** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/session_recording_playlists/"
```

**Create recording playlist** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Bug Reports","derived_name":"Bug Reports","pinned":false}' \
  "https://app.posthog.com/api/projects/{project_id}/session_recording_playlists/"
```

Recordings are read-only via API — you cannot create, modify, or delete session recordings themselves.

### HogQL Queries

**Execute HogQL query** (`posthog:posthog.read`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT event, count() as total FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY total DESC LIMIT 20"}' \
  "https://app.posthog.com/api/projects/{project_id}/query/"
```

HogQL is a ClickHouse-compatible SQL dialect. Available tables:
- `events` — event data (most commonly queried)
- `persons` — person profiles (may contain PII — warn the user)
- `session_recording_events` — session recording metadata
- `raw_session_replay_events` — raw replay snapshots
- `cohort_people` — cohort membership
- `insights_query` — cached insight results

Rate limit: 2400 queries/hour. Response is raw JSON rows.

**Warn about PII**: If the query targets `persons` table properties or selects email/name/distinct_id fields, warn the user that the result may contain personally identifiable information.

### Schema & Taxonomy

**List event definitions** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/event_definitions/"
```

Returns all known event names with volume, description, and tags. Useful for discovering what events exist before querying.

**Get event definition** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/event_definitions/{definition_id}/"
```

**List property definitions** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/property_definitions/"
```

Returns all known property names, types, and which events they're associated with.

**Get property definition** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/property_definitions/{definition_id}/"
```

**List custom actions** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/actions/"
```

**Create custom action** (`posthog:posthog.write`):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Signed Up","steps":[{"event":"user_signed_up"}]}' \
  "https://app.posthog.com/api/projects/{project_id}/actions/"
```

### Groups

PostHog supports group analytics (tracking behavior per organization/workspace rather than per user).

**List group types** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/groups/types/"
```

Returns available group types (e.g., `organization`, `company`, `project`).

**List groups of a type** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/groups/{group_type_index}/"
```

**Get group detail** (`posthog:posthog.read`):

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/groups/{group_type_index}/{group_key}/"
```

Returns group properties and associated events.

## Pagination & Filtering

### Cursor Pagination
PostHog uses cursor-based pagination. The response includes a `next` field with the full URL for the next page (or `null` if no more pages). Follow it directly:

```bash
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "{next_url_from_response}"
```

Do not construct your own cursor values — always use the provided `next` URL.

### Time Format
- Always ISO 8601 in UTC: `2024-01-15T00:00:00Z`
- Omit seconds if irrelevant: `2024-01-15T00:00Z`
- Relative shorthand accepted by some endpoints: `-7d`, `-24h`, `-30d`, `-90d`

### Property Filters
JSON filter arrays must be URL-encoded when used as GET query parameters. Use `--data-urlencode`:

```bash
curl -s -G \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  --data-urlencode 'properties=[{"key":"plan","operator":"exact","value":"pro","type":"event"}]' \
  "https://app.posthog.com/api/projects/{project_id}/events/"
```

### Ordering
Use `?orderBy=-timestamp` for newest-first (descending) or `?orderBy=timestamp` for chronological (ascending).

## Quick Examples
Every example includes the required env setup. Copy the full sequence.

### Verify auth
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/users/@me/"
```

### List projects
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/" | python3 -c "import json,sys; [print(f'{p[\"id\"]:>6}  {p[\"name\"]:<30}  {p.get(\"organization_name\",\"\")}') for p in json.load(sys.stdin).get('results',[])]"
```

### Query events from yesterday
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -G \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  --data-urlencode 'after=-1d' \
  --data-urlencode 'limit=10' \
  "https://app.posthog.com/api/projects/{project_id}/events/"
```

### Query events with name filter
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -G \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  --data-urlencode 'after=2024-06-01T00:00:00Z' \
  --data-urlencode 'before=2024-06-02T00:00:00Z' \
  --data-urlencode 'event=user_signed_up' \
  --data-urlencode 'limit=50' \
  "https://app.posthog.com/api/projects/{project_id}/events/"
```

### List feature flags
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/" | python3 -c "import json,sys; [print(f'{f[\"id\"]:>6}  {f[\"key\"]:<35}  active={f[\"active\"]}') for f in json.load(sys.stdin).get('results',[])]"
```

### Create feature flag
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"new_onboarding","name":"New Onboarding Flow","active":false,"filters":{"groups":[{"properties":[],"rollout_percentage":0}]}}' \
  "https://app.posthog.com/api/projects/{project_id}/feature_flags/"
```

### List dashboards
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/dashboards/" | python3 -c "import json,sys; [print(f'{d[\"id\"]:>6}  {d[\"name\"]:<40}  tiles={len(d.get(\"tiles\",[]))}') for d in json.load(sys.stdin).get('results',[])]"
```

### Run HogQL query
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -X POST \
  -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT event, count() as total FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY total DESC LIMIT 10"}' \
  "https://app.posthog.com/api/projects/{project_id}/query/"
```

### List event definitions
```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_PERSONAL_KEY"
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/projects/{project_id}/event_definitions/" | python3 -c "import json,sys; [print(f'{e[\"name\"]:<45}  vol={e.get(\"volume_30_day\",0)}') for e in json.load(sys.stdin).get('results',[])]"
```

## Output
- Keep replies concise and operational.
- Include project name, project ID, and relevant identifiers.
- For lists, use a compact format: one line per item with ID + name + key detail.
- When listing events, include timestamp and event name. For large result sets, summarize with counts.
- Report errors with the exact `curl` method + URL attempted, the HTTP status code, and the PostHog error detail (if available in the response body).
- Never print the `POSTHOG_PERSONAL_KEY`, `POSTHOG_PROJECT_KEY`, or any credential value.
- Separate confirmed PostHog facts from assumptions or conclusions.
- If blocked by missing key or API errors, state the blocker and the smallest next step.

## Checks
- Always export `POSTHOG_PERSONAL_KEY` before any API call.
- Always verify the key with `GET /api/users/@me/` before doing real work.
- Always confirm the `project_id` before running a project-scoped operation. Never guess.
- Never print credential values, tokens, or API key values.
- Destructive operations (any `DELETE`) must be explicitly requested by the user before proceeding.
- Use `--data-urlencode` for JSON query parameters in GET requests to avoid curl escaping issues.
- PostHog enforces a time window on queries. Default to last 7 days if the user doesn't specify.
- HogQL queries against `persons` or `events` tables may contain PII. Warn the user.
- Feature flag changes take effect instantly. The permission gate must be strict.
- Tokens are in the environment

## Cross-skill convention
Other skills that need PostHog operations (querying events, checking feature flags, reading dashboards) should not embed their own `curl` calls. Route PostHog work through this skill.
