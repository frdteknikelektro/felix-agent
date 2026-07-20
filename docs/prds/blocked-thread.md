# Block / Unblock Thread

## Problem Statement

Felix currently processes every event that passes `shouldAcceptEvent` (DMs, mentions, or replies inside a `managed_by_felix` thread). There is no way for the Owner to silence a thread, conversation, or contact without shutting the bot down or editing `thread.json` by hand. The Owner needs a one-action pause that:

- Stops Felix from generating replies on that thread.
- Persists the silence so a restart does not resume the thread.
- Replays the conversation in order when the Owner unblocks it, so nothing is silently lost.
- Works uniformly across every source adapter (WhatsApp, Discord, Slack, Mattermost, Telegram) without per-adapter wiring.

## Solution

Add a single `blocked: boolean` field to `ThreadState`. While a thread is blocked:

- The engine still persists the raw event and appends it to the thread's event log and `session.json.queue`, exactly as it does today for accepted events.
- The engine does **not** start `processThread` for queued events, so no LLM turn fires and no reply is sent.
- The `/unblock` command (chat) and the `POST /api/threads/:threadKey/unblock` route (REST) flip the flag back to `false` and call `processThread`, which drains the queued events in the same order they arrived.

A `/block` chat command and `POST /api/threads/:threadKey/block` route set the flag to `true`. The chat command path is special-cased at the top of `handleEventAcceptance` (alongside `/stop`, `/compact`, `/new`) so an Owner can unblock from a blocked thread.

Block applies to all event visibility (`dm` and `channel`) — DMs are threads too. The `/unblock` command is the only chat path that bypasses the block check.

## User Stories

1. As an Owner, I want to send `/block` in a thread, so that Felix stops replying to that thread immediately.
2. As an Owner, I want to send `/unblock` in a blocked thread, so that I can resume the conversation without leaving the chat.
3. As an Owner, I want to call `POST /api/threads/:threadKey/block`, so that I can silence a thread from the owner console or a script.
4. As an Owner, I want to call `POST /api/threads/:threadKey/unblock`, so that I can resume a thread from the owner console or a script.
5. As an Owner, I want blocked-thread events to be persisted in the event log and session queue, so that nothing is lost while the thread is blocked.
6. As an Owner, I want blocked-thread events to be replayed in order after unblock, so that the conversation continues with full context.
7. As an Owner, I want the block state to survive a Felix restart, so that a reboot does not accidentally resume a thread I paused.
8. As an Owner, I want blocking to work in DMs as well as channels, so that one-to-one conversations can be silenced with the same mechanism.
9. As an Owner, I want a non-`/unblock` message in a blocked thread to not generate a reply, so that I can leave the thread alone without it waking up.
10. As an Owner, I want non-mention channel messages in a blocked, `managed_by_felix` thread to not trigger a turn, so that background chatter stays paused.
11. As an Owner, I want a blocked thread to not call the harness (no LLM tokens spent), so that a long pause does not waste budget.
12. As an Owner, I want `/block` and `/unblock` to be visible in the thread transcript, so that the audit trail shows when the state changed.
13. As an Owner, I want a Telegram thread to support block and unblock the same way as WhatsApp / Discord / Slack / Mattermost, so that the behavior is consistent across sources.
14. As an Owner, I want the block flag to be a boolean (not a timestamped or rich object), so that the model is small and the only state is "currently blocked or not".
15. As an Owner, I want a brand-new thread (no events yet) to be blockable from the REST route, so that I can pre-emptively silence a known-noisy contact.
16. As an Owner, I want blocked events to keep being de-duplicated, so that redelivery from a source platform does not produce duplicate queue items.
17. As an Owner, I want a non-Owner user to not be able to flip the block state, so that an unauthorized contact cannot silence or revive a thread.

## Implementation Decisions

- **Seam for the block check** — extend `shouldAcceptEvent(event, thread)` in `src/core/routing.ts`. The pure predicate already gates everything; the only new branch is a single early return `if (thread?.blocked) return false;` at the top. Tests live in `tests/routing.test.ts`, which already covers the other branches.
- **Schema change** — `ThreadStateSchema` in `src/core/schemas.ts` gains a single field `blocked: z.boolean().optional()`. The `optional` is intentional: existing `thread.json` records that lack the field parse cleanly and read back with `state.blocked === undefined`, which behaves as `false` everywhere the engine checks it (truthy-guard). No migration script is needed. `repairThreadStateByDir` does not need to touch it.
- **Queued mode is automatic** — the engine already calls `queueThreadEvent` and `processThread` separately in `handleEventAcceptance`. The block path reuses a shared `persistAndQueueEvent` helper (download attachments, append to thread, update `managed_by_felix`, push to `session.json.queue`, notify source of "processing") and then skips the `processThread` kick. `sanitizeThreadQueue`, `recoverThreads`, and the existing `processThreadInternal` drain logic already replay queued events on demand, so no new replay machinery is needed.
- **Mid-drain block guard** — `processThreadInternal` re-checks the live `blocked` flag at the top of every loop iteration. This closes a race where the Owner calls `/block` (or `setBlocked(true)` via REST) while a drain is in flight: any in-flight turn completes, then the loop bails out before draining events that arrived during the block. Without this guard, a blocked event that landed in the queue while a drain was running would still be processed.
- **Command surface** — `/block` and `/unblock` are detected in `handleEventAcceptance` before `shouldAccept` is consulted. This mirrors how `/stop`, `/compact`, `/new` are handled. A single `isBlockOrUnblockCommand` static predicate covers both commands and is reused by the ingest-side bypass.
- **Chat command authorization** — the engine guards `/block` and `/unblock` with `isOwnerMessage(event, source, ownerUserId)` (in `src/core/routing.ts`, symmetric to `isOwnMessage`). When the source has no `ownerUserId` configured the guard returns false (closed by default), so non-Owner senders in a managed channel cannot flip state. Failure is silent — no chat reply, no harness call, no state change.
- **REST surface** — two `POST` routes in `src/server/routes.ts`:
  - `POST /api/threads/:threadKey/block`
  - `POST /api/threads/:threadKey/unblock`
    Both share a single `setThreadBlockedRoute` helper (one-liner per route: parse the key, call the engine, map the result). The route table is the only place HTTP status codes are mapped. Owner-data is read-only per the glossary and is not involved in the write path.
- **Engine port is the single home** — `FelixEngine.setBlocked(threadKey, blocked)` is the only writer of the blocked flag. Both the chat command and the REST route call into it. It is also the only path that creates a brand-new thread stub when the key is unseen (parses `<source>` from the leading segment of the thread key, calls `createOrLoadThread` with a minimal `source_thread_ref: { source }`, then sets the flag). On unblock it kicks `processThread` so any events queued during the block drain in order. The chat command's drain is triggered the same way via the `kickProcessThread` private helper.
- **Telegram parity** — the block check sits in the engine, not in any adapter. Telegram is wired identically to the others. The Telegram adapter already exists at `src/adapters/telegram/index.ts`; the engine's `requireAdapter` and `ownerDisplayForSource` already know the source name. No adapter code is touched.
- **Transcript** — chat-side `/block` and `/unblock` replies are appended through the existing `postThreadReply`, so they show up in the transcript exactly like `/stop` and `/new` do. No new transcript type.
- **No new permissions** — neither the chat command nor the REST route introduces a new permission. The REST route inherits the existing owner-console auth (`OWNER_UI_SECRET` cookie), the chat command runs in an already-managed thread.

## Testing Decisions

- **Pure routing** — `tests/routing.test.ts` gains cases for `shouldAcceptEvent` with `blocked: true` and `blocked: false` on `dm` and `channel` events. Pure function, no IO, mirrors the existing test style (small `makeEvent` factory, one `expect` per scenario). Also covers `isOwnerMessage` is a non-event in this test file — the engine-level suite below exercises it end-to-end.
- **Engine-level block / unblock** — `tests/blocked-thread.test.ts` (new) uses a `RecordHarness` helper (in `tests/helpers/fake-harness.ts`) that records every `run` call, plus a `waitFor` polling helper for async drains. Scenarios:
  - `setBlocked(true)` causes subsequent events to be queued without harness calls.
  - `setBlocked(false)` causes queued events to drain in arrival order.
  - Owner's `/block` chat command flips the flag and produces a chat reply.
  - Owner's `/unblock` chat command clears the flag and drains the queue.
  - Non-Owner `/block` and `/unblock` chat commands are silently ignored (no reply, no state change).
  - `setBlocked` on a previously-unseen thread key creates a stub thread rather than throwing.
- **REST route** — `tests/server-routes-block.test.ts` (new) drives the route through the route table matcher with a stub `RouteContext`, asserting the response shape on both `/block` and `/unblock`. No HTTP server is spun up.
- **Persistence roundtrip** — `tests/thread-state-schema.test.ts` (new) asserts a `ThreadState` with `blocked: true` survives a `writeJsonAtomic` → `readJsonParsed` cycle, and that a record without the field reads back as `undefined` (i.e., not present). The existing `tests/contract-roundtrip.test.ts` covers the AGENTS.md output contract and is intentionally not extended.
- **What we don't test** — adapter-level behavior, Telegram / Discord / Slack / WhatsApp / Mattermost platform wiring, and harness-side effects. The block check is engine-owned, so adapter tests are unaffected.

## Out of Scope

- Rich block metadata (reason, blocked-by, blocked-at, expiry). The boolean is the only state.
- Per-contact blocking that is not tied to a thread (e.g. "ignore everything from user X across all threads"). That's a separate feature with a separate data shape.
- UI affordances in the owner console SPA. The REST endpoints are exposed; the SPA is not updated in this PRD.
- Notification of the Owner when a thread is blocked (e.g. a "thread X was blocked" log line is fine; pushing a message back to the Owner is out).
- Block policies based on message content (regex, profanity filter, etc.). This is a manual Owner toggle only.
- Concurrent block / unblock races beyond what `setThreadBusy` and `processThread` already serialize. The boolean is the only mutable field, and the Owner is the only writer; we accept that two REST calls in flight could race on the read-modify-write of `thread.json` and document the limitation in a note.

## Further Notes

- The existing `TaskStatus` enum already has a `"blocked"` member — that is the **task** domain (work items in `tasks/<status>/`), unrelated to thread block. No naming conflict in code because the only consumer of `TaskStatus` is `slices/tasks/`. Worth a one-line glossary addendum if a future contributor confuses the two.
- The `managed_by_felix` flag is the closest cousin: both live on `ThreadState` and both gate `processThread`. The mental model is "managed = Felix has ever spoken here; blocked = Felix is currently silent here". Documented in the engine module.
- A follow-up PRD may add a UI surface and a per-contact blocklist; the engine seam (one boolean in `shouldAcceptEvent`) should remain stable across both.
