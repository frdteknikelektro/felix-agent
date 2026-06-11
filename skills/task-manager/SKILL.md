---
id: task-manager
name: Task Manager
description: Kanban-style task tracking. Create, list, start, update, and complete tasks from any thread.
version: 1
enabled: true
kind: operational
permissions:
  - task.create
  - task.read
match:
  - task, todo, kanban, board, backlog, sprint, task list
  - make this a task, make a task, taskify, turn this into a task
  - create a task for this, create task
---

# Task Manager

## Purpose
Kanban board with create → start → done lifecycle. Tasks persist as JSON files on disk. Cross-thread notification via source API.

## When to use
- User asks for a task or todo list
- User asks to create, start, finish, cancel, block, pause, or reopen a task
- User says "make this a task" to capture a thread's context
- User asks for "board" or "kanban" to see all tasks
- User wants to see a specific task's detail

## Out of scope
- Project management (no assignments, due dates, estimates, velocity)
- UI-based task management
- Automatic task creation from events
- Recursive tasks or subtasks

## Operations
- create — write new task to backlog
- make-this-a-task — draft + confirm, then create
- start / done / cancel / block / pause — move file between status dirs
- reopen — move back to backlog (never to active)
- board — list all tasks in table format
- show — display full task detail

## Environment

Base directories (use the `$WORKSPACE_DIR` environment variable — already set by the harness, do NOT redefine it):

```bash
TASKS_DIR="${WORKSPACE_DIR}/tasks"
# Subdirs: backlog/ active/ done/ cancelled/ blocked/ paused/
```

Required tools (available in runtime image): `jq`, `date`, `mv`, `ls`, `head`. No install needed.

## Workflow

### A. Explicit creation (`create task: <title>`)

The title is everything after `create task:`. The description is synthesized from thread context — read event files and the transcript to capture what was discussed, what's needed, and what "done" means.

**Step 0 — gather context fields from your turn prompt:**

Your turn context always contains the current event's sender, thread key, source, and the thread transcript path. Use these:

```bash
SOURCE="<from turn context — e.g. mattermost>"
USER_ID="<from turn context — sender user id>"
PARENT_SOURCE="$SOURCE"
PARENT_THREAD_KEY="<from turn context — thread key>"
PARENT_POST_ID="<from turn context — source_thread_ref.root_message_id or thread_id>"
THREAD_TRANSCRIPT="<from turn context — transcript path>"
```

**Step 1 — generate ID, create file:**

```bash
TS=$(date +%s)
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
TASK_ID="${TS}-${SLUG}"
N=2; ORIG_ID="$TASK_ID"
while [ -f "$TASKS_DIR/backlog/$TASK_ID.json" ]; do
  TASK_ID="${ORIG_ID}-${N}"; N=$((N + 1))
done
mkdir -p "$TASKS_DIR/backlog"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg id "$TASK_ID" \
  --arg title "$TITLE" \
  --arg description "$DESC" \
  --arg created_at "$NOW" \
  --arg source "$SOURCE" \
  --arg user_id "$USER_ID" \
  --arg parent_source "$PARENT_SOURCE" \
  --arg parent_thread_key "$PARENT_THREAD_KEY" \
  --argjson parent_post_id "${PARENT_POST_ID:-null}" \
  '{schema_version:1,id:$id,status:"backlog",title:$title,description:$description,created_at:$created_at,created_by:{source:$source,user_id:$user_id},parent_source:$parent_source,parent_thread_key:$parent_thread_key,parent_post_id:$parent_post_id,started_at:null,completed_at:null,updated_at:$created_at}' \
  > "$TASKS_DIR/backlog/$TASK_ID.json"
```

**Step 2 — reply:**

```
✓ Task `task-id` "the title" created [backlog].
```

### B. "Make this a task" (with confirmation)

When the user says "make this a task" (or variants like "taskify", "turn this into a task", "create a task for this"):

1. Read the thread transcript and recent event files to understand what "this" refers to.
2. Draft a title (one-line summary) and a thorough description (context, links, what's needed, what "done" means, any decisions made).
3. Reply using this exact machine-parseable format:

```
DRAFT_TITLE: <one-line summary>
DRAFT_DESC: <thorough description with context and what "done" means>

Create this task? Reply yes/no or suggest changes.
```

4. On the next turn, search the thread transcript for `DRAFT_TITLE:` and capture until the first blank line:

```bash
grep -A50 "DRAFT_TITLE:" "$THREAD_TRANSCRIPT" | sed '/^$/q'
```

This returns the `DRAFT_TITLE:` line plus the full `DRAFT_DESC:` content. Extract the title from the `DRAFT_TITLE:` line and the description from `DRAFT_DESC:` (everything between `DRAFT_DESC:` and the blank line or end of output).

5. If the draft is not found, ask: "Could not find the draft — what task should I create?"
6. If the user confirms (plain "yes", "ok", "go ahead", or similar), proceed with the title and description from the draft using Workflow A.
7. If the user suggests changes ("yes but call it X"), use the modified title/description.

Never create the task without receiving confirmation first.

### C. Board view (`board` / `kanban`)

List all tasks across all status dirs in a markdown table:

```bash
printf "| Status    | Task ID                    | Title                 | Updated             |\n"
printf "|-----------|----------------------------|-----------------------|---------------------|\n"
for d in backlog active done cancelled blocked paused; do
  for f in "$TASKS_DIR/$d"/*.json; do
    [ -f "$f" ] || continue
    STATUS="$d"
    jq -r '"| \(env.STATUS) | \(.id) | \(.title) | \(.updated_at) |"' "$f"
  done
done
```

If no tasks exist: `No tasks yet. Create one with "create task: ...".`

### D. Status transitions (`start` / `done` / `cancel` / `block` / `pause` / `reopen`)

**Step 1 — find the task:**

```bash
TASK_ID="<task id from user message>"
NEW_STATUS="<target status>"
TASK_FILE=""
CURRENT=""
for d in backlog active done cancelled blocked paused; do
  if [ -f "$TASKS_DIR/$d/$TASK_ID.json" ]; then
    TASK_FILE="$TASKS_DIR/$d/$TASK_ID.json"
    CURRENT="$d"
    break
  fi
done
if [ -z "$TASK_FILE" ]; then
  echo "not_found"
  exit 0
fi
if [ "$CURRENT" = "$NEW_STATUS" ]; then
  echo "already_$NEW_STATUS"
  exit 0
fi
```

If not found, reply: `Task not found: \`<id>\`.` If already in the target status, reply: `Task \`<id>\` is already <status>.`

**Step 2 — move the file:**

```bash
mkdir -p "$TASKS_DIR/$NEW_STATUS"
mv "$TASK_FILE" "$TASKS_DIR/$NEW_STATUS/$TASK_ID.json"
```

**Step 3 — patch timestamps with `jq`:**

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DEST="$TASKS_DIR/$NEW_STATUS/$TASK_ID.json"

# Read current values
CURRENT_STARTED=$(jq -r '.started_at // "null"' "$DEST")
CURRENT_DONE=$(jq -r '.completed_at // "null"' "$DEST")

# Determine new timestamp values based on the transition
case "$NEW_STATUS" in
  active)
    [ "$CURRENT_STARTED" = "null" ] && STARTED="$NOW" || STARTED="$CURRENT_STARTED"
    DONE="null"
    ;;
  done)
    STARTED="$CURRENT_STARTED"
    [ "$CURRENT_DONE" = "null" ] && DONE="$NOW" || DONE="$CURRENT_DONE"
    ;;
  backlog)
    STARTED="null"
    DONE="null"
    ;;
  *)
    STARTED="$CURRENT_STARTED"
    DONE="$CURRENT_DONE"
    ;;
esac

jq \
  --arg status "$NEW_STATUS" \
  --arg updated_at "$NOW" \
  --argjson started_at "$STARTED" \
  --argjson completed_at "$DONE" \
  '.status=$status | .updated_at=$updated_at | .started_at=$started_at | .completed_at=$completed_at' \
  "$DEST" > "$DEST.tmp" && mv "$DEST.tmp" "$DEST"
```

Timestamp rules:
| Transition | `started_at` | `completed_at` |
|---|---|---|
| → active | set to now (if null) | null |
| → done | keep existing | set to now (if null) |
| → cancelled / blocked / paused | keep existing | keep existing |
| → backlog (reopen) | null | null |

**Step 4 — reply:**

`Task \`<id>\` → <new-status>.`

### E. Show task (`show <id>`)

```bash
TASK_ID="<task id>"
for d in backlog active done cancelled blocked paused; do
  if [ -f "$TASKS_DIR/$d/$TASK_ID.json" ]; then
    jq -r '"Task: \(.id)\nTitle: \(.title)\nStatus: \(.status)\nDescription: \(.description)\nCreated: \(.created_at) by \(.created_by.source):\(.created_by.user_id)\nStarted: \(.started_at // "-")\nCompleted: \(.completed_at // "-")\nParent thread: \(.parent_source) \(.parent_thread_key)"' \
      "$TASKS_DIR/$d/$TASK_ID.json"
    exit 0
  fi
done
```

## Notification (cross-thread)

After a status transition, optionally post a concise update to the parent thread. All source tokens are already in the environment.

### Mattermost

Parse `mattermost:<channel_id>:<root_post_id>` from `parent_thread_key`:

```bash
PARENT_CHANNEL=$(echo "$PARENT_THREAD_KEY" | cut -d: -f2)
PARENT_POST=$(echo "$PARENT_THREAD_KEY" | cut -d: -f3)
[ -z "$PARENT_POST" ] && PARENT_POST="$PARENT_CHANNEL"

MSG="📋 \`<task-id>\` \"<title>\" — status: <new-status>"
PAYLOAD=$(node -e 'console.log(JSON.stringify({channel_id:process.env.PARENT_CHANNEL,root_id:process.env.PARENT_POST,message:process.env.MSG}))')
curl -sS -X POST \
  -H "Authorization: Bearer $MATTERMOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$MATTERMOST_URL/api/v4/posts"
```

### Discord

```bash
PARENT_CHANNEL=$(echo "$PARENT_THREAD_KEY" | cut -d: -f2)
MSG="📋 \`<task-id>\` \"<title>\" — status: <new-status>"
curl -sS -X POST \
  -H "Authorization: Bot $DISCORD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"$MSG\"}" \
  "https://discord.com/api/v10/channels/$PARENT_CHANNEL/messages"
```

### Slack

```bash
PARENT_CHANNEL=$(echo "$PARENT_THREAD_KEY" | cut -d: -f2)
PARENT_TS=$(echo "$PARENT_THREAD_KEY" | cut -d: -f3)
MSG="📋 \`<task-id>\` \"<title>\" — status: <new-status>"
curl -sS -X POST \
  -H "Authorization: Bearer $SLACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(node -e 'console.log(JSON.stringify({channel:process.env.PARENT_CHANNEL,thread_ts:process.env.PARENT_TS,text:process.env.MSG}))')" \
  "https://slack.com/api/chat.postMessage"
```

## Output

- **Task creation:** `✓ Task \`<id>\` "<title>" created [backlog].`
- **Draft:** `DRAFT_TITLE: ...\nDRAFT_DESC: ...\n\nCreate this task? Reply yes/no or suggest changes.`
- **Status change:** `Task \`<id>\` → <new-status>.`
- **Board:** Always the pipe-separated markdown table format shown in Workflow C.
- **Show:** Always the key-value format shown in Workflow E.
- **Not found:** `Task not found: \`<id>\`.`
- **Already in status:** `Task \`<id>\` is already <status>.`
- **No tasks:** `No tasks yet. Create one with "create task: ...".`

## Checks

- Always resolve `$TASKS_DIR` from `$WORKSPACE_DIR`. Never hardcode workspace paths.
- Never guess task IDs — read from disk or ask the user.
- Validate a task exists before any status transition.
- Validate the target status dir exists before moving.
- Do not overwrite existing files — use collision check on creation (the `while [ -f ... ]` loop).
- For "make this a task", always confirm before creating — never skip confirmation.
- Use the `DRAFT_TITLE:` / `DRAFT_DESC:` format for drafts so you can parse them on the next turn.
- `reopen` always moves to `backlog`, never to `active`.
- Keep board output concise — one row per task, no prose.
- Use `jq -n` for JSON construction (not heredocs) to avoid special-character breakage.
- All source tokens are already in the environment — no need to source any file.
- If notification fails (curl non-zero), log the error but proceed — the task status has already changed.
- Never print credential values, tokens, or API keys in output or logs.
