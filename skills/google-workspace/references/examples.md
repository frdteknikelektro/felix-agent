# Example Conversations

How user requests map to `gog` commands and permission checks.

## Read-only operations

**User: "Check my email"**
→ `gog gmail search 'newer_than:1d' --json`. Returns recent emails inline.
Permission: `read.gmail`.

**User: "What's on my calendar today?"**
→ `gog calendar events --today --json`. Returns events inline.
Permission: `read.calendar`.

**User: "Search my Drive for 'budget'"**
→ `gog drive search 'budget' --json`. Returns matching files inline.
Permission: `read.drive`.

**User: "Read the doc 'Project Plan'"**
→ `gog docs cat <docId> --json`. Returns doc content.
Permission: `read.docs`.

## Write operations

**User: "Send an email to john@example.com about the meeting tomorrow"**
→ Confirm details first, then `gog gmail send --to john@example.com --subject "Meeting tomorrow" --body "..." --json`.
Permission: `write.gmail`.

**User: "Create a doc called 'Project Plan'"**
→ `gog docs create "Project Plan" --json`. Returns doc ID and URL.
Permission: `write.docs`.

**User: "Create a calendar event for tomorrow 10am"**
→ Confirm details, then `gog calendar create --summary "..." --from <datetime> --to <datetime> --json`.
Permission: `write.calendar`.

## Destructive operations (require confirmation)

**User: "Delete that email"** (after a search result)
→ Preview: `gog gmail get <messageId> --json`. Show summary.
→ Ask: "Confirm delete?"
→ `gog gmail trash <messageId> --json`.
Permission: `write.gmail`.

**User: "Remove that file"**
→ Preview: `gog drive get <fileId> --json`. Show name and location.
→ Ask: "Confirm delete?"
→ `gog drive delete <fileId> --json`.
Permission: `write.drive`.

## Multi-account

**User: "Check my work email"**
→ If multiple accounts: "Which account? You have: user@gmail.com, user@company.com"
→ `gog --account user@company.com gmail search 'newer_than:1d' --json`.
Permission: `read.gmail`.

## No auth

**User: "Check my email"** (no account authorized)
→ "No Google account is set up yet. Let me guide you through the setup."
→ Read `references/setup.md` and walk the owner through first-time auth.
