---
name: usage-report
description: Token-usage reporting for today, week, month, or all time, including contact, source, model, and thread breakdowns. Use for Felix token totals or consumption breakdowns.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: usage.read
  match: token usage, tokens used, usage report, token consumption
---

## Permissions

- `usage.read` — Read token usage records and run the reporter.

This skill is read-only; no write permission exists.

# Usage Report

Report recorded token counts through the bundled read-only reporter. Pricing and dollar cost are not recorded.

## Execution

1. Confirm `usage-report:usage.read` is granted. Otherwise emit the standard `PERMISSION_REQUIRED` block and stop.
2. Map the request to exactly one window: `today`, `week`, `month`, or `all`. If the user asks for a complete report, omit the argument to render every window.
3. Run:

   ```bash
   node "${WORKSPACE_DIR}/.agents/skills/usage-report/report.mjs" <window>
   ```

4. Relay the requested section after the command exits successfully. If it reports no records, say `No usage recorded yet.`

Completion requires that the displayed window matches the request and every count comes from reporter output.

## Data contract

The reporter reads `${WORKSPACE_DIR}/usage/<YYYY-MM-DD>.jsonl`. Day, ISO-week, and month boundaries use `OWNER_TZ`; deprecated `USAGE_TZ` is only a compatibility fallback, then UTC. Never redefine these environment variables, modify usage files, or infer monetary cost.
