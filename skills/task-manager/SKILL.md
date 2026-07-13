---
name: task-manager
description: Kanban task lifecycle for creating, listing, showing, starting, completing, cancelling, blocking, pausing, and reopening tasks. Use for task, todo, backlog, board, sprint, or "make this a task" requests.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  permissions: task.create, task.read
  match: task, todo, kanban, board, backlog, sprint, make this a task
---

# Task Manager

Use the bundled CLI as the single writer for `${WORKSPACE_DIR}/tasks`; do not recreate its JSON mutations in shell. Statuses are `backlog`, `active`, `done`, `cancelled`, `blocked`, and `paused`.

The board has no assignments, due dates, estimates, recursive subtasks, or automatic event-to-task conversion.

```bash
TASK_CLI="${WORKSPACE_DIR}/.agents/skills/task-manager/task.mjs"
```

## Permission boundary

- Board/show: require `task-manager:task.read`.
- Create or transition: require `task-manager:task.create`.

Stop at the standard permission flow until the required permission is granted.

## Create

For `create task: <title>`, synthesize a durable description from the current transcript: context, relevant links, requested work, decisions already made, and observable completion criteria.

Pass context as JSON so punctuation and multiline descriptions remain valid:

```bash
jq -n \
  --arg title "$TITLE" \
  --arg description "$DESC" \
  --arg source "$SOURCE" \
  --arg user_id "$USER_ID" \
  --arg parent_source "$SOURCE" \
  --arg parent_thread_key "$THREAD_KEY" \
  --arg parent_post_id "$PARENT_POST_ID" \
  '{title:$title,description:$description,source:$source,user_id:$user_id,parent_source:$parent_source,parent_thread_key:$parent_thread_key,parent_post_id:(if $parent_post_id == "" then null else $parent_post_id end)}' \
  | node "$TASK_CLI" create
```

Completion requires the CLI success line and a readable file in `tasks/backlog/` with the same ID, title, and description.

## “Make this a task”

This branch always confirms before creating:

1. Read the transcript and draft:

   ```text
   DRAFT_TITLE: <one-line summary>
   DRAFT_DESC: <context, links, work, decisions, and completion criteria>

   Create this task? Reply yes/no or suggest changes.
   ```
2. On the confirmation turn, recover the latest draft from the transcript with `grep -A50 "DRAFT_TITLE:"`, apply requested edits, and run Create only after an explicit confirmation.
3. If no unambiguous draft exists, ask what to create; never reconstruct one from guesswork.

## Read

```bash
node "$TASK_CLI" board
node "$TASK_CLI" show "<exact-task-id>"
```

Never guess a task ID. Use `board` to resolve it or ask the user.

## Transition

```bash
node "$TASK_CLI" transition "<exact-task-id>" start
node "$TASK_CLI" transition "<exact-task-id>" done
node "$TASK_CLI" transition "<exact-task-id>" cancel
node "$TASK_CLI" transition "<exact-task-id>" block
node "$TASK_CLI" transition "<exact-task-id>" pause
node "$TASK_CLI" transition "<exact-task-id>" reopen
```

`reopen` always returns a task to `backlog`, never `active`. Completion requires the CLI success line and `show` reporting the target status.

If the transition occurred outside the parent thread, use that source's instructions from `INITIAL.md` to post one concise status update. Notification failure does not roll back the committed task transition; report the failure without exposing credentials.
