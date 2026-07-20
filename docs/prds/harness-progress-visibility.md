# Harness progress visibility across supported harnesses

## Problem Statement

Felix users can tell that a session is busy, but they cannot see what the harness is doing while a turn is running. The current owner console exposes coarse session state and completed activity, while harness adapters already receive native streaming output that is mostly reduced to a final answer and a raw log. This makes long-running turns look stalled and makes retries, tool use, permission waits, and cancellation difficult to understand. Owners who work primarily from the CLI also need a stable file they can follow with standard tools such as `tail -F`.

## Solution

Introduce a Felix-owned Harness progress model shared by OpenCode, Codex, and Claude Code. Each harness maps its native output into a small common set of Progress phases while retaining optional provider-specific detail at the adapter boundary.

Detailed Progress is visible through two Owner surfaces. The Dashboard shows a compact current-progress summary, Session detail shows the fuller current state, and a sanitized append-only Progress NDJSON artifact is available in the thread's existing turn-artifact area for CLI tailing and post-turn inspection. Live console Progress is delivered through the existing authenticated dashboard SSE stream and held transiently in memory; the sanitized artifact, completed turn status, and raw harness logs remain durable, but intermediate Progress events do not become session history.

The live surface is redacted by default. It may show phase, elapsed time, attempt number, tool identity, and a short sanitized status, but never private reasoning, full prompts, tool arguments, command output, or arbitrary model text. The UI reports truthful phases and elapsed time rather than inventing a percentage or steps that a harness did not provide.

## User Stories

1. As an Owner, I want to see which sessions are currently executing, so that a long-running request does not look stalled.
2. As an Owner, I want to see the current Progress phase for an active session, so that I know whether Felix is starting, thinking, using a tool, waiting, or finishing.
3. As an Owner, I want the Dashboard to show a compact current-progress summary, so that I can monitor several active sessions without opening each one.
4. As an Owner, I want Session detail to show the fuller current-progress state, so that I can investigate one active turn without reading raw logs.
5. As an Owner, I want to see elapsed time for the current turn, so that I can distinguish normal work from a potentially stalled harness.
6. As an Owner, I want to see the current harness identity, so that I know whether OpenCode, Codex, or Claude Code is executing the turn.
7. As an Owner, I want OpenCode tool and step activity mapped into Progress, so that OpenCode turns expose useful operational detail.
8. As an Owner, I want Codex activity mapped into the same Progress model, so that changing harnesses does not change how I monitor Felix.
9. As an Owner, I want Claude Code to expose at least honest lifecycle states, so that a harness with limited streaming detail is still observable.
10. As an Owner, I want the UI to degrade gracefully when a harness provides limited detail, so that Felix never displays fabricated steps, tools, or percentages.
11. As an Owner, I want a fresh retry to be shown as a new Progress attempt, so that I can distinguish recovery from one uninterrupted execution.
12. As an Owner, I want cancellation to become an explicit cancelled state, so that I know whether work stopped intentionally.
13. As an Owner, I want permission waits to be visible as a distinct state, so that I know why a turn is not advancing.
14. As an Owner, I want failed and completed turns to clear active Progress, so that stale “running” indicators do not remain after execution ends.
15. As an Owner, I want Progress to update through the existing live dashboard connection, so that the console reflects activity without manual refresh.
16. As an Owner, I want a reconnecting dashboard to recover the current durable session snapshot, so that the console remains useful after a temporary connection loss.
17. As a source user, I want Felix to keep the existing coarse processing indicator and final reply behavior, so that detailed operational updates do not clutter my conversation.
18. As an Owner, I want live Progress to exclude prompts, reasoning, tool arguments, command output, and arbitrary model text, so that the monitoring surface does not leak sensitive or noisy content.
19. As an Owner, I want raw harness logs to remain available as protected artifacts after a turn, so that detailed debugging is still possible without making the live UI a transcript.
20. As an Owner, I want a failure in Progress delivery to leave the turn running normally, so that observability cannot become a new execution failure mode.
21. As an Owner, I want multiple active sessions to have independent current Progress, so that activity from one thread cannot appear on another.
22. As an Owner, I want progress events to be ordered within a turn, so that the UI does not display an older phase after a newer one.
23. As an Owner, I want the system to report phases and elapsed time instead of false completion percentages, so that the monitoring information remains trustworthy.
24. As an Owner working from the CLI, I want a stable sanitized Progress artifact, so that I can follow an active turn with `tail -F`.
25. As an Owner, I want the Progress artifact to remain after the turn finishes, so that I can inspect the operational trace without having to reproduce the turn.
26. As an Owner, I want the CLI artifact to be separate from the raw harness log, so that I can tail a useful operational view without exposing provider-specific payloads.
27. As an Owner, I want the CLI artifact to use one structured JSON event per line, so that I can filter or process it with standard command-line tools.
28. As an Owner, I want artifact writes to be best-effort and redacted, so that CLI observability cannot break execution or leak sensitive content.

## Implementation Decisions

- Define a small Felix-owned Progress event contract with common lifecycle and activity phases: started, thinking, tool_started, tool_finished, waiting_permission, completed, failed, and cancelled. The contract includes thread/session identity, attempt identity, timestamp, sequence/order information, phase, elapsed-time context, and a sanitized human-readable status.
- Permit optional harness-specific metadata, such as native event type, model, tool identity, or normalized usage, without requiring every harness to provide it or exposing raw provider payloads to the UI.
- Add a Progress observer/sink to the harness turn flow. Harness adapters publish normalized events through it while the turn runs; Progress observation is best-effort and cannot change the Harness result or execution control flow.
- Keep native event parsing inside each harness adapter. OpenCode maps its JSON stream, Codex maps its JSON events, and Claude Code maps its available output into the shared contract. The shared core does not parse provider-specific event formats.
- Cover all supported harnesses in the first implementation. OpenCode and Codex provide detailed activity where their streams support it; Claude Code provides coarse lifecycle state unless its configured mode supplies more detail.
- Correct OpenCode event mapping for the current JSON stream, including its step, text, tool, reasoning, and error event forms. Native event details remain diagnostic rather than becoming a public API contract.
- Maintain an in-memory current-Progress bus keyed by thread and turn attempt. Replace the current event for each thread as new events arrive, remove active state on terminal phases, and do not persist intermediate Progress events as session history.
- Append each redacted Progress event to one stable per-thread NDJSON artifact in the existing turn-artifact area. Include thread/session identity, attempt, timestamp, sequence, phase, elapsed context, and sanitized status so `tail -F` shows a useful live stream and the completed file remains inspectable.
- Keep the Progress artifact separate from raw provider stdout/stderr logs. The artifact is durable by default and is not automatically deleted when a turn finishes; retention and cleanup are a later policy concern.
- Extend the existing authenticated dashboard SSE stream to publish live Progress updates. Continue using the durable dashboard snapshot for session, queue, approval, and usage state; do not introduce WebSockets or a second live transport.
- Extend Dashboard and Session detail data models with current Progress and the configured harness identity. The displayed harness must reflect the selected runtime harness rather than a hardcoded value.
- Dashboard rows show a compact status; Session detail shows the current phase, elapsed time, attempt, harness, and sanitized status. Neither view shows a historical Progress timeline.
- Preserve the existing source-user behavior. Detailed Progress is an Owner-console feature, not a source conversation contract.
- Apply redaction before Progress reaches the bus or SSE payload. Never send private reasoning, full prompts, tool arguments, command output, or arbitrary model-generated text as live Progress.
- Represent retry, cancellation, permission wait, completion, and failure explicitly. A retry starts a new attempt; terminal states clear active Progress.
- Do not provide a numeric completion percentage unless a harness explicitly supplies a reliable total-work measure. Current harnesses should use phases and elapsed time.
- Keep completed turn status, raw harness logs, and the sanitized Progress artifact durable through the existing session/artifact mechanisms. Progress remains outside the conversation event schema.

## Testing Decisions

- Tests must assert observable behavior: normalized Progress reaching the Owner-facing live state, correct terminal behavior, redaction, isolation between threads, and execution continuing when Progress observation fails. Tests should not assert private helper structure or provider parser implementation details beyond their observable mapping.
- Use one primary integration seam: a Harness progress sink flowing through the turn runner into the live dashboard Progress state and SSE stream. This verifies the cross-layer contract once at the highest useful seam.
- Add focused native-event fixture tests for OpenCode, Codex, and Claude Code. Each test supplies representative native output and asserts the normalized phases and safe details exposed by the adapter.
- Extend existing harness stream tests to cover OpenCode event mapping, including tool/step events, and to prove that stream errors still fail the turn correctly while Progress remains observational.
- Extend existing owner web/SSE tests to verify authenticated delivery, current Progress updates, terminal clearing, reconnect behavior, and configured harness identity.
- Add lifecycle tests for fresh retries, cancellation, permission waits, completion, failure, and attempt ordering.
- Add redaction tests proving that prompts, reasoning, tool arguments, command output, and arbitrary model text cannot enter Progress payloads.
- Add artifact tests proving that redacted Progress is appended as valid NDJSON while a turn runs, remains available after completion, is tail-friendly, and is not deleted automatically.
- Add failure-isolation tests in which the Progress sink or SSE subscriber throws; the harness turn must still return its normal result.
- Add multi-thread tests proving that Progress for one thread cannot overwrite another thread's current state.
- Run the existing unit, typecheck, build, harness, and owner-console test suites as regression coverage.

## Out of Scope

- Posting detailed Progress updates back to Mattermost, Discord, Slack, WhatsApp, Telegram, or other source conversations.
- A historical Progress timeline in session history or a new persisted Progress event schema. The separate sanitized CLI Progress artifact is explicitly in scope.
- Numeric completion percentages inferred from elapsed time, token counts, or guessed task size.
- Exposing private reasoning, full prompts, tool arguments, command output, or arbitrary model text in the live console.
- Replacing SSE with WebSockets or adding a separate dashboard streaming protocol.
- Making every harness expose identical native detail.
- Enabling a new Claude Code streaming mode solely to achieve parity with OpenCode.
- Changing harness execution semantics, permission policy, retry policy, cancellation policy, or final-reply formatting beyond adding observation hooks.
- Automatic Progress artifact cleanup, rotation, quotas, or retention configuration.
- Building a public telemetry service or sending Felix-owned analytics outside the customer workspace.

## Further Notes

- The current OpenCode adapter already receives JSON events in real time but currently treats them primarily as final-output material and raw logs; its event-to-Progress mapping is the first concrete adapter correction.
- OpenCode’s native stream is the inspiration for detailed activity, but Felix owns the stable Progress vocabulary so the UI is not coupled to one provider.
- Claude Code’s current non-streaming JSON mode may only support coarse lifecycle Progress. That is an accepted capability difference, not a reason to fabricate detail.
- Progress is an Owner observability concern. The durable session read model remains the source of truth for completed conversation state, the in-memory Progress bus is the source of truth for current console state, and the sanitized Progress artifact is the CLI-facing operational trace.
- This PRD follows ADR 0012, “Keep a sanitized Progress artifact for CLI observation,” which supersedes the console-only retention boundary in ADR 0011.
