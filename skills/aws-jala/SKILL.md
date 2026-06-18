---
id: aws-jala
name: AWS Jala Management
description: Use for broad Jala AWS account administration through the AWS CLI, including read-only inspection, billing lookups, and explicitly requested remote-state changes. Uses text-based read/write permission guidance with the project-level AWS_JALA_* secret env contract.
version: 1
enabled: true
kind: operational
permissions:
  - aws.read
  - aws.write
match:
  - aws
  - aws jala
  - jala aws
  - s3
  - ec2
  - iam
  - lambda
  - cloudformation
  - billing
  - cost explorer
  - cost and usage
  - rds
  - ecs
  - ecr
  - cloudwatch
---

# AWS Jala Management

## Purpose
Operate Jala's configured AWS environment through the AWS CLI. This skill covers AWS inventory, diagnostics, billing lookups, and broad admin operations when the requester has the matching permission.

Use text-based permission judgment. Do not add or rely on hardcoded TypeScript command detection for AWS read/write classification.

## Permission Policy
Use the user's requested intent and the likely AWS effect to choose the required permission:

- `aws-jala:aws.read` — inspection, inventory, diagnostics, billing lookups, Cost Explorer reads, and commands whose purpose is to observe existing state. Examples: `list`, `get`, `describe`, `show`, `head`, `sts get-caller-identity`, `ce get-cost-and-usage`.
- `aws-jala:aws.write` — create, update, delete, attach, detach, put, revoke, terminate, deploy, restore, modify, or any other operation that can change remote AWS state.

If an operation is ambiguous, treat it as `aws-jala:aws.write` unless the user is only asking to inspect or explain current state.

Destructive operations are allowed only when the user explicitly asks for the specific destructive intent, such as deleting a bucket object, terminating an instance, deleting a stack, revoking IAM access, or removing a policy.

## Environment
Use credentials from the environment before every AWS CLI command. Do not use credential files, and do not require `AWS_JALA_PROFILE`.

Required variables:
- `AWS_JALA_ACCESS_KEY_ID`
- `AWS_JALA_SECRET_ACCESS_KEY`

Optional variables:
- `AWS_JALA_SESSION_TOKEN`
- `AWS_JALA_REGION`

Command pattern:

```bash
export AWS_ACCESS_KEY_ID="$AWS_JALA_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$AWS_JALA_SECRET_ACCESS_KEY"
if [ -n "${AWS_JALA_SESSION_TOKEN:-}" ]; then export AWS_SESSION_TOKEN="$AWS_JALA_SESSION_TOKEN"; fi
if [ -n "${AWS_JALA_REGION:-}" ]; then export AWS_REGION="$AWS_JALA_REGION"; export AWS_DEFAULT_REGION="$AWS_JALA_REGION"; fi
aws <service> <operation> ...
```

Before AWS work, verify required values without printing secrets:

```bash
test -n "$AWS_JALA_ACCESS_KEY_ID" &&
test -n "$AWS_JALA_SECRET_ACCESS_KEY" &&
aws sts get-caller-identity
```

Never print credential values, secret-derived env, or full signed request material.

## Workflow
1. Classify the requested work as read or write using the permission policy above.
2. export standard AWS CLI variables from `AWS_JALA_*`, and verify required credentials are present without exposing values.
3. Use direct `aws` CLI commands. If `aws` is missing, use the `install-tool` skill to install it before continuing.
4. For read tasks, return confirmed AWS facts and include the relevant command summary.
5. For write tasks, perform only the requested change. For destructive work, proceed only when the user's request explicitly names the destructive intent.
6. Report command outcomes concisely, including the affected service, resource identifiers, region when known, and any AWS errors.

## Use Cases
Use cases are repeatable operating recipes. They may produce artifacts, but they do not have to. Load the relevant reference only when the user's request matches it.

- **Monthly cost summary report** — read `references/use-cases/cost-summary-monthly-report.md` when the user asks for a monthly AWS cost summary report, billing report bundle, two-month cost comparison, service cost breakdown, Name-tag cost breakdown, no-credit view, charts, markdown summary, or monthly cost artifacts.
- **EC2 inventory** — read `references/use-cases/ec2-inventory.md` when the user asks which EC2 instances are running, what instances exist, or needs a compact compute inventory.
- **IAM access review** — read `references/use-cases/iam-access-review.md` when the user asks to inspect IAM users, access keys, attached policies, or broad access risk.

## Quick Examples
Read-only inventory uses `aws-jala:aws.read`:

```bash
aws ec2 describe-instances \
  --filters Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,Name:Tags[?Key==`Name`]|[0].Value,Type:InstanceType,AZ:Placement.AvailabilityZone}' \
  --output table
```

Remote-state changes use `aws-jala:aws.write`:

```bash
aws lambda update-function-configuration \
  --function-name <function-name> \
  --environment Variables='{KEY=value}'
```

## References
- `references/platform-context.md` — Jala AWS operating context, common service areas, and fallback notes.

## Output
- Keep replies concise and operational.
- Separate confirmed AWS facts from assumptions.
- Include exact commands run or command summaries, with secrets redacted.
- If blocked by missing env, missing AWS CLI, missing region, permissions, or AWS API errors, state the blocker and the smallest next step.
