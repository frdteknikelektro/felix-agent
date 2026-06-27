---
# ┌─────────────────── Every skill must have these ───────────────────┐
id: template-skill
name: Template Skill
description: Replace with a one‑sentence description of what this skill does and when it activates.
version: 1
enabled: false
# kind: general      — no permissions needed, triggered by match
#        operational — has permissions, triggered by match
#        persona     — creative / conversational, triggered by match
kind: general
# └───────────────────────────────────────────────────────────────────┘

# ┌─ permissions — use bare {domain}.{action} names ─────────────────┐
#  | Format                   | Example               |
#  |--------------------------|-----------------------|
#  | `{domain}.read`          | `github.read`         |
#  | `{domain}.write`         | `github.write`        |
#  | `{domain}.review`        | `github.review`       |
#  | `{domain}.run`           | `install.run`         |
#  | `{domain}.{action}`      | `felix-browser.navigate`|
#  | `{domain}.create`        | `task.create`         |
#  The runtime namespaces these as `{skill-id}:{permission}` at load time.
permissions: []
# └───────────────────────────────────────────────────────────────────┘

# ┌─ match — trigger phrases (optional) ─────────────────────────────┐
# Leave empty if the skill is always loaded (e.g. memory).
match:
  - replace me
  - trigger phrase
# └───────────────────────────────────────────────────────────────────┘

# ┌─ env — environment variables this skill needs (optional) ────────┐
# npm run setup scans this and prompts the user.
#  | Field         | Required | Description                      |
#  |---------------|----------|----------------------------------|
#  | `key`         | yes      | env var name                    |
#  | `description` | yes      | what it provides access to      |
#  | `required`     | no       | `true` or `false` (default)    |
#  | `default`     | no       | pre‑filled value if unset       |
# env:
#   - key: YOUR_API_KEY
#     description: What this key provides access to
#     required: true
#   - key: YOUR_OPTIONAL_URL
#     description: Base URL for the service
#     required: false
#     default: https://api.example.com
# └───────────────────────────────────────────────────────────────────┘
---

# Template Skill

## Purpose

Describe what this skill does and why it exists.

**Example:**
> Deploy the current project to a cloud platform. Triggered when the
> user asks to ship, release, or go live.

## When to use

List the situations where this skill should activate.

**Example:**
> - User says "deploy", "ship it", "go live", "release to production"
> - User asks to promote a staging build
> - User runs `/deploy` in the chat

## Out of scope

What this skill should NOT handle.

**Example:**
> - Building or compiling — that's a separate build step
> - Running tests — CI handles that
> - Cloud infrastructure provisioning (IAM, networking, databases)

## Use cases

Concrete end‑to‑end scenarios this skill handles.

**Example:**
> - **Push to staging:** user says "ship the latest to staging"
>   → build → deploy to staging → reply with staging URL
> - **Full release:** user says "go live with v2.3.0"
>   → confirm with user → build → deploy to production → reply with production URL
> - **Rollback:** user says "that deploy broke the login page, roll it back"
>   → find previous deployment → execute rollback → confirm restoration

## Permissions

List every permission this skill needs, one per line. Use bare
`{domain}.{action}` permission names in frontmatter. The runtime namespaces
these as `{skill-id}:{permission}` at load time.

**For this example skill:**
> - `deploy.run` — execute the deployment
> - `deploy.rollback` — revert a failed deployment

## Workflow

Step‑by‑step instructions the LLM should follow when this skill activates.

**Example:**

1. Read `package.json` to confirm the project identity.
2. Run `npm run build` to produce the artifact.
3. Determine the target environment (staging / production) from the user's message.
4. Execute the deploy command: `npx deploy --env=$ENV`.
5. Report the result with a link to the live deployment.

## Checks

Checklist items for the LLM to verify before/after execution.

**Example:**
- [ ] Build succeeded with exit code 0
- [ ] Environment is explicitly confirmed (never assume production)
- [ ] Deployment response includes a valid URL
- [ ] Rollback plan is documented in the reply
