# Jala PostHog Context

This file documents known Jala PostHog organizations, projects, and conventions. It is best-effort — if an API call using a reference ID returns 404, re-list projects via the API to get current state and update this file.

## Organizations

| Name | Org ID | Notes |
|---|---|---|
| Jala | `10590` | Main Jala organization — core product projects |
| Jala Widget | `28053` | Widget-related products and experiments |

## Projects

### Jala (org 10590)

Use `GET /api/organizations/10590/projects/` to list all projects. Known projects:

_(Populate with actual project names and IDs after discovery via the API.)_

### Jala Widget (org 28053)

Use `GET /api/organizations/28053/projects/` to list all projects. Known projects:

_(Populate with actual project names and IDs after discovery via the API.)_

## Live Discovery Commands

Use these to refresh the project listing when the reference above is stale:

```bash
export POSTHOG_PERSONAL_KEY="$POSTHOG_JALA_PERSONAL_KEY"

# List Jala (10590) projects
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/10590/projects/" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('results', []):
    print(f'{p[\"id\"]:>6}  {p[\"name\"]}')
"

# List Jala Widget (28053) projects
curl -s -H "Authorization: Bearer $POSTHOG_PERSONAL_KEY" \
  "https://app.posthog.com/api/organizations/28053/projects/" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('results', []):
    print(f'{p[\"id\"]:>6}  {p[\"name\"]}')
"
```

## Event Naming Conventions

_(Document Jala event naming patterns here once discovered — e.g., common prefixes, standard property keys, known custom events.)_

Common PostHog internal events (prefix `$`):
- `$pageview` — page view
- `$pageleave` — page leave
- `$autocapture` — auto-captured clicks and inputs
- `$identify` — user identification
- `$feature_flag_called` — feature flag evaluated
- `$survey_shown` / `$survey_dismissed` — survey interactions
- `$experiment_participation` — experiment enrollment

## Key Dashboards

_(Document frequently referenced Jala dashboards here — dashboard ID, name, project it belongs to, and what it tracks.)_

## Notes
- This file is for agent reference only — always verify with the live API if an ID returns 404.
- Project IDs and names change when projects are renamed or recreated.
- Keep this file updated when new projects or dashboards are discovered.
