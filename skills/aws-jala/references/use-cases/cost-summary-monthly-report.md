# Cost Summary Monthly Report

## When to use
Use this recipe when the user asks for a monthly AWS cost summary report, billing report bundle, two-month cost comparison, service cost breakdown, Name-tag cost breakdown, credit-excluded view, charts, markdown summary, or monthly cost artifacts for Jala.

This use case is the `aws-jala` version of the standalone cost summary report skill. It keeps the same report depth, but it is implemented as a markdown runbook using direct AWS CLI commands and session-local snippets. Do not call checked-in shell orchestration scripts such as `build-two-month-report.sh`, and do not depend on `knowledge/platforms/...`.

Default period:
- Summarize the latest completed calendar month.
- Compare it with the immediately previous completed calendar month.
- If today is `2026-06-02`, use `Start=2026-04-01`, `End=2026-06-01`, and compare April 2026 with May 2026.

Allow explicit overrides. If the user asks for a specific month pair, quarter, or start/end window, follow the requested period instead of the default.

## Permission
Required permission: `aws-jala:aws.read`.

Cost Explorer is read-only in this workflow. Do not require `aws-jala:aws.write`.

Installing local report-generation dependencies, such as Python charting packages, is allowed when needed for the artifact bundle. This is local environment setup, not AWS remote-state mutation.

## Inputs
Required:
- None by default. If no period is supplied, compute the latest completed month and the previous completed month from the execution date.

Optional:
- Period override, such as `Jan-Feb 2026`, `2026-01-01 to 2026-03-01`, or `last quarter`.
- Title override for the markdown report.
- Output directory override.
- Tag key override. Default tag key is `Name`.

## Output contract
Produce a full report artifact bundle by default. A quick chat-only billing lookup should use the main `aws-jala` billing workflow instead of this recipe.

For the default two-month report, produce:
- Six Cost Explorer JSON exports.
- Nine PNG charts when Python charting dependencies are available or can be installed.
- One markdown summary report.

If charting fails after reasonable local setup, still produce the JSON exports and markdown report. State that charts were skipped and include the dependency or runtime blocker.

## Working directory
Write generated files under the active session directory when Felix exposes one. If no active session directory is available, create a timestamped directory under:

```text
workspace/reports/aws-jala/cost-summary/<YYYYMMDDHHMMSS>-<older-month>-<latest-month>/
```

Do not write generated report artifacts into `skills/` or `knowledge/`.

Use a filename prefix derived from the compared months, for example:

```text
apr-may-2026
```

## Date resolution
Resolve the report window before querying Cost Explorer:

1. Determine today's date at execution time.
2. Find the first day of the current month.
3. Set `End` to the first day of the current month.
4. Set the latest completed month to the month before `End`.
5. Set the older comparison month to the month before the latest completed month.
6. Set `Start` to the first day of the older comparison month.

Cost Explorer uses an exclusive `End` date. For April-May 2026, use:

```text
Start=2026-04-01
End=2026-06-01
```

## Workflow
1. Resolve `START_DATE`, `END_DATE`, compared month labels, and `PREFIX`.
2. Use environment variables and export standard AWS CLI variables from `AWS_JALA_*` as described in the main skill.
3. Run `aws sts get-caller-identity` once to confirm the active account without printing credentials.
4. Create the report working directory.
5. Export the six Cost Explorer JSON files listed below.
6. Install local charting dependencies when needed and reasonable.
7. Generate nine PNG charts from the JSON exports.
8. Generate one markdown summary report from the JSON exports.
9. Return a concise summary and list all generated artifact paths.

## Cost Explorer exports
Use `UnblendedCost` and `UsageQuantity` for every query.

Raw monthly totals:

```bash
aws ce get-cost-and-usage \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --metrics UnblendedCost UsageQuantity \
  --output json \
  > "cost-usage-${PREFIX}.json"
```

Monthly totals excluding credits:

```bash
aws ce get-cost-and-usage \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --metrics UnblendedCost UsageQuantity \
  --filter '{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit"]}}}' \
  --output json \
  > "cost-usage-${PREFIX}-no-credit.json"
```

Service breakdown:

```bash
aws ce get-cost-and-usage \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --group-by Type=DIMENSION,Key=SERVICE \
  --metrics UnblendedCost UsageQuantity \
  --output json \
  > "cost-usage-${PREFIX}-service.json"
```

Service breakdown excluding credits:

```bash
aws ce get-cost-and-usage \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --group-by Type=DIMENSION,Key=SERVICE \
  --metrics UnblendedCost UsageQuantity \
  --filter '{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit"]}}}' \
  --output json \
  > "cost-usage-${PREFIX}-service-no-credit.json"
```

Name-tag breakdown:

```bash
aws ce get-cost-and-usage \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --group-by Type=TAG,Key=Name \
  --metrics UnblendedCost UsageQuantity \
  --output json \
  > "cost-usage-${PREFIX}-tag-name.json"
```

Name-tag breakdown excluding credits:

```bash
aws ce get-cost-and-usage \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --group-by Type=TAG,Key=Name \
  --metrics UnblendedCost UsageQuantity \
  --filter '{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit"]}}}' \
  --output json \
  > "cost-usage-${PREFIX}-tag-name-no-credit.json"
```

The no-credit view excludes only `RECORD_TYPE=Credit`, matching the standalone report behavior. Do not silently exclude refunds, discounts, support, taxes, upfront charges, or reserved charges unless the user requests a different named view.

## Chart artifacts
Generate these nine PNG charts by default:

- `${PREFIX}-cost-usage-net.png`
- `${PREFIX}-cost-usage-no-credit.png`
- `${PREFIX}-cost-usage-credit-overlay.png`
- `${PREFIX}-service-stack-net.png`
- `${PREFIX}-service-stack-no-credit.png`
- `${PREFIX}-service-stack-credit-overlay.png`
- `${PREFIX}-tag-name-stack-net.png`
- `${PREFIX}-tag-name-stack-no-credit.png`
- `${PREFIX}-tag-name-stack-credit-overlay.png`

If Python charting dependencies are missing, install local dependencies when possible:

```bash
python3 -m pip install --user matplotlib
```

Do not add checked-in helper scripts for this use case. If code is needed, write session-local Python files inside the report working directory, run them, and leave them with the generated artifacts for auditability.

The chart script should read the six JSON exports and render:
- Net monthly total cost and usage comparison.
- No-credit monthly total cost and usage comparison.
- Credit overlay comparison showing net vs no-credit totals.
- Service stacked cost comparison for net, no-credit, and credit overlay.
- Name-tag stacked cost comparison for net, no-credit, and credit overlay.

## Markdown report
Generate one markdown report:

```text
aws-jala-${PREFIX}-report.md
```

Use this structure:

```markdown
# AWS-Jala <Older Month> - <Latest Month> Cost Summary

## Account
- Account: <account id or arn summary>
- Report period: <START_DATE> to <END_DATE exclusive>
- Generated at: <timestamp>
- Credits: net view includes credits; no-credit view excludes RECORD_TYPE=Credit only

## Executive Summary
- Total net cost for each month
- Month-over-month delta and percentage
- Total no-credit cost for each month
- Main cost drivers

## Monthly Totals
| Month | Net cost | No-credit cost | Usage quantity |

## Service Breakdown
| Service | Older month | Latest month | Delta |

## Name Tag Breakdown
| Name tag | Older month | Latest month | Delta |

## Charts
- <relative chart paths>

## Source Data
- <relative JSON export paths>

## Notes
- Any Cost Explorer, tag coverage, dependency, or permission limitations
```

## Artifact checklist
Before replying, verify the bundle contains:
- `cost-usage-${PREFIX}.json`
- `cost-usage-${PREFIX}-no-credit.json`
- `cost-usage-${PREFIX}-service.json`
- `cost-usage-${PREFIX}-service-no-credit.json`
- `cost-usage-${PREFIX}-tag-name.json`
- `cost-usage-${PREFIX}-tag-name-no-credit.json`
- `${PREFIX}-cost-usage-net.png`
- `${PREFIX}-cost-usage-no-credit.png`
- `${PREFIX}-cost-usage-credit-overlay.png`
- `${PREFIX}-service-stack-net.png`
- `${PREFIX}-service-stack-no-credit.png`
- `${PREFIX}-service-stack-credit-overlay.png`
- `${PREFIX}-tag-name-stack-net.png`
- `${PREFIX}-tag-name-stack-no-credit.png`
- `${PREFIX}-tag-name-stack-credit-overlay.png`
- `aws-jala-${PREFIX}-report.md`

## Failure modes
- Missing `AWS_JALA_*` env: report the missing variable names only.
- Missing AWS CLI: use the `install-tool` skill.
- Cost Explorer access denied: report the IAM permission blocker.
- No tag data: explain that Cost Explorer tag activation or tagging coverage may be missing.
- Dependency installation blocked: still produce JSON exports and markdown report, then state why charts were not produced.
- Period override is ambiguous: ask for the intended period before querying.
