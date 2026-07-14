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

- **Seam for the block check** — extend `shouldAcceptEvent(event, thread)` in `src/core/routing.ts`. The pure predicate already gates everything; the only new branch is `if (thread?.blocked) return false`. Tests live in `tests/routing.test.ts`, which already covers the other branches.
- **Schema change** — `ThreadStateSchema` in `src/core/schemas.ts` gains a single field `blocked: z.boolean().default(false)`. No new tables, no new files, no migration script. Existing `thread.json` records that lack the field are valid; the Zod default fills it on read. `repairThreadStateByDir` does not need to touch it.
- **Queued mode is automatic** — the engine already calls `queueThreadEvent` and `processThread` separately in `handleEventAcceptance`. The block path just appends + queues, then skips the `processThread` kick. `sanitizeThreadQueue`, `recoverThreads`, and the existing `processThreadInternal` drain logic already replay queued events on demand, so no new replay machinery is needed.
- **Command surface** — `/block` and `/unblock` are detected in `handleEventAcceptance` before `shouldAccept` is consulted. This mirrors how `/stop`, `/compact`, `/new` are handled. The detection helper lives in `engine.ts` next to the existing command predicates (`isStopCommand`, `isCompactCommand`, `isNewCommand`).
- **Chat command authorization** — the existing routing path already only enqueues events for a thread Felix manages, and `/block` / `/unblock` is a side-effect the Owner runs from a managed thread. Non-Owner senders reach the command only if they are in a Felix-managed thread and their message otherwise passes `shouldAcceptEvent`; for a non-Owner to flip state, the source adapter must surface their message as a turn trigger. The decision is to accept that risk for the first version: chat-side block is Owner-driven, REST-side block is the same as the existing owner-console flows. Add an Owner-only guard (sender is the configured `ownerUserId` for the thread's source) in the command handler so non-Owner senders in a managed channel cannot flip state.
- **REST surface** — two `POST` routes in `src/server/routes.ts`:
  - `POST /api/threads/:threadKey/block`
  - `POST /api/threads/:threadKey/unblock`
  Both go through the owner-data facade (mirroring the approval routes), validate the thread exists, call into the engine, and return `{ ok: true, blocked: <bool> }`. The route table is the only place HTTP status codes are mapped.
- **Owner-data helper** — `setThreadBlocked(cfg, threadKey, blocked)` in `src/owner-data.ts` is the single home for "set the flag, persist, and trigger `processThread` if unblocking". Both the chat command and the REST route call this. The engine exposes a thin `setBlocked(threadKey, blocked)` port that `owner-data` invokes.
- **Engine port** — `FelixEngine.setBlocked(threadKey, blocked)` is a new method that:
  1. Loads the thread, calls `updateThreadState(handle, { blocked })`.
  2. If the new value is `false`, calls `processThread` (which respects the existing busy / dedup semantics, so it is a no-op if a turn is already running).
- **Telegram parity** — the block check sits in the engine, not in any adapter. Telegram is wired identically to the others. The Telegram adapter already exists at `src/adapters/telegram/index.ts`; the engine's `requireAdapter` and `ownerDisplayForSource` already know the source name. No adapter code is touched.
- **Transcript** — chat-side `/block` and `/unblock` replies are appended through the existing `postThreadReply`, so they show up in the transcript exactly like `/stop` and `/new` do. No new transcript type.
- **No new permissions** — neither the chat command nor the REST route introduces a new permission. The REST route inherits the existing owner-console auth (`OWNER_UI_SECRET` cookie), the chat command runs in an already-managed thread.

## Testing Decisions

- **Pure routing** — `tests/routing.test.ts` gains cases for `shouldAcceptEvent` with `blocked: true` and `blocked: false` on `dm` and `channel` events. Pure function, no IO, mirrors the existing test style (small `makeEvent` factory, one `expect` per scenario).
- **Engine-level block / unblock** — `tests/engine-routing.test.ts` gains scenarios using the `FakeHarness`:
  - `/block` flips the flag, no harness call happens, the next event is queued.
  - `/unblock` flips the flag back, the next event triggers a harness call, queued events drain in order.
  - A non-`/unblock` event in a blocked thread queues without triggering a harness call.
  - A non-Owner sender's `/block` (or `/unblock`) reply in a managed thread is rejected — no state change, no harness call.
- **REST route** — `tests/server-routes.test.ts` (or a new test file under `tests/`) calls the engine and the owner-data facade in isolation; the route handler is a thin wrapper so it can be unit-tested through the route table matcher without spinning up the HTTP server.
- **Persistence roundtrip** — extend `tests/contract-roundtrip.test.ts` to assert a `ThreadState` with `blocked: true` survives a save → `readJsonParsed(ThreadStateSchema)` cycle, and that an existing record without the field reads back with the default `false`.
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
