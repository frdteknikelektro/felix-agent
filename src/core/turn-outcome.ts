import type { ContactRecord, SessionQueueItem, UniversalEvent } from "../types.js";
import type { ThreadHandle } from "../slices/sessions/index.js";
import type { PermissionRequiredOutput, TurnResult } from "./ports.js";
import { decideTurnResult } from "./decide-turn.js";

export interface TurnOutcomePorts {
  clearHarnessSession(thread: ThreadHandle): Promise<void>;
  logUsage(thread: ThreadHandle, event: UniversalEvent, result: TurnResult): Promise<void>;
  recordTurnWithUsage(thread: ThreadHandle, event: UniversalEvent, result: TurnResult): Promise<void>;
  postThreadError(thread: ThreadHandle, event: UniversalEvent, errorDetail: string): Promise<void>;
  postThreadReply(thread: ThreadHandle, event: UniversalEvent, sessionId: string | undefined, text: string): Promise<void>;
  requestPermission(
    thread: ThreadHandle,
    event: UniversalEvent,
    parsed: PermissionRequiredOutput,
  ): Promise<void>;
  autoGrantPermission(
    thread: ThreadHandle,
    event: UniversalEvent,
    sessionId: string,
  ): Promise<void>;
  runFormatCorrection(prompt: string): Promise<TurnResult>;
  requeueEvent(thread: ThreadHandle, item: SessionQueueItem): Promise<void>;
  isStopRequested(threadKey: string): boolean;
  clearStopRequested(threadKey: string): void;
  warn(message: string, data: Record<string, unknown>): void;
  error(message: string, data: Record<string, unknown>): void;
}

export interface TurnOutcomeInput {
  thread: ThreadHandle;
  event: UniversalEvent;
  item: SessionQueueItem;
  contact: ContactRecord;
  result: TurnResult;
  resumed: boolean;
  retriedFreshStart: boolean;
  retryCounts: Map<string, number>;
  ports: TurnOutcomePorts;
}

export type TurnOutcomeResult =
  | { kind: "retry_fresh"; resumed: false; retriedFreshStart: true }
  | { kind: "complete" }
  | { kind: "stopped" };

export async function handleTurnOutcome(input: TurnOutcomeInput): Promise<TurnOutcomeResult> {
  const decision = decideTurnResult(input.result, input.resumed, input.retriedFreshStart);

  if (decision.kind === "retry_fresh") {
    input.ports.warn("harness.resume_fallback", {
      thread_key: input.thread.state.thread_key,
      session_id: input.result.sessionId,
      exit_code: input.result.exitCode,
      log_path: input.result.logPath,
    });
    await input.ports.clearHarnessSession(input.thread);
    return { kind: "retry_fresh", resumed: false, retriedFreshStart: true };
  }

  if (decision.kind === "fail") {
    if (input.resumed) {
      await input.ports.clearHarnessSession(input.thread);
    }
    // A failed turn can still have burned tokens (API succeeded, output was
    // unusable). Record them so the ledger isn't undercounted — logUsage is a
    // no-op when result.usage is null (e.g. the harness never reached the API).
    await input.ports.logUsage(input.thread, input.event, input.result);
    const detail = input.result.exitCode !== 0
      ? exitCodeMessage(input.result.exitCode)
      : "The agent produced no usable output. ";
    await input.ports.postThreadError(input.thread, input.event, detail);
    input.ports.error("harness.empty_output", {
      thread_key: input.thread.state.thread_key,
      session_id: input.result.sessionId,
      exit_code: input.result.exitCode,
      log_path: input.result.logPath,
    });
    return { kind: "complete" };
  }

  if (decision.kind === "format_retry") {
    return handleFormatRetry(input);
  }

  await applySuccessfulOutcome(input, input.result);
  return { kind: "complete" };
}

export async function handleTurnRunError(input: {
  thread: ThreadHandle;
  event: UniversalEvent;
  item: SessionQueueItem;
  error: unknown;
  retryCounts: Map<string, number>;
  ports: TurnOutcomePorts;
}): Promise<Extract<TurnOutcomeResult, { kind: "complete" | "stopped" }>> {
  if (input.ports.isStopRequested(input.thread.state.thread_key)) {
    input.ports.clearStopRequested(input.thread.state.thread_key);
    return { kind: "stopped" };
  }

  const retryCount = input.retryCounts.get(input.item.source_event_id) ?? 0;
  const detail = input.error instanceof Error ? `${input.error.message}. ` : "";
  if (retryCount >= 2) {
    await input.ports.postThreadError(input.thread, input.event, detail);
    return { kind: "complete" };
  }

  input.retryCounts.set(input.item.source_event_id, retryCount + 1);
  await input.ports.requeueEvent(input.thread, input.item);
  await input.ports.postThreadError(input.thread, input.event, detail);
  return { kind: "complete" };
}

async function handleFormatRetry(input: TurnOutcomeInput): Promise<TurnOutcomeResult> {
  input.ports.warn("harness.format_error", {
    thread_key: input.thread.state.thread_key,
    session_id: input.result.sessionId,
    error: input.result.parsed.text,
  });
  // The malformed first attempt already burned tokens; record them before the
  // correction re-run so the ledger isn't undercounted.
  await input.ports.logUsage(input.thread, input.event, input.result);

  let corrected: TurnResult;
  try {
    corrected = await input.ports.runFormatCorrection(formatCorrectionPrompt(input.result.parsed.text));
  } catch (error) {
    return handleTurnRunError({
      thread: input.thread,
      event: input.event,
      item: input.item,
      error,
      retryCounts: input.retryCounts,
      ports: input.ports,
    });
  }

  if (input.ports.isStopRequested(input.thread.state.thread_key)) {
    return { kind: "stopped" };
  }

  const retriedDecision = decideTurnResult(corrected, true, input.retriedFreshStart);
  if (retriedDecision.kind === "retry_fresh") {
    await input.ports.clearHarnessSession(input.thread);
    return { kind: "retry_fresh", resumed: false, retriedFreshStart: true };
  }

  if (retriedDecision.kind === "fail" || retriedDecision.kind === "format_retry") {
    if (input.resumed) {
      await input.ports.clearHarnessSession(input.thread);
    }
    await input.ports.postThreadError(input.thread, input.event, "The agent produced no usable output. ");
    return { kind: "complete" };
  }

  await applySuccessfulOutcome(input, corrected);
  return { kind: "complete" };
}

async function applySuccessfulOutcome(
  input: Pick<TurnOutcomeInput, "thread" | "event" | "contact" | "ports">,
  result: TurnResult,
): Promise<void> {
  await input.ports.recordTurnWithUsage(input.thread, input.event, result);
  if (result.parsed.kind !== "permission_required") {
    await input.ports.postThreadReply(input.thread, input.event, result.sessionId, result.parsed.text);
    return;
  }

  const permOutput = result.parsed as PermissionRequiredOutput;
  const skillId = permOutput.skillId ?? "(unknown)";
  const bareMissing = (permOutput.permissions ?? []).filter(
    (p) => {
      const namespaced = p.includes(":") ? p : `${skillId}:${p}`;
      return !input.contact.allowed_permissions.includes(namespaced);
    },
  );
  if (bareMissing.length === 0) {
    await input.ports.autoGrantPermission(input.thread, input.event, result.sessionId);
    return;
  }
  await input.ports.postThreadReply(input.thread, input.event, result.sessionId, permOutput.text);
  await input.ports.requestPermission(input.thread, input.event, {
    ...permOutput,
    permissions: bareMissing,
  });
}

export function formatCorrectionPrompt(errorText: string): string {
  return [
    "Your last output had a format error:",
    "",
    errorText,
    "",
    "Please re-read the latest event and produce a correctly formatted PERMISSION_REQUIRED block.",
    "Make sure every field is filled: skill, permissions (with at least one `- <name>` bullet), reason, owner_message, and end with END_PERMISSION_REQUIRED.",
  ].join("\n");
}

function exitCodeMessage(exitCode: number): string {
  switch (exitCode) {
    case -1:
      return "The agent process could not start. ";
    case 1:
      return "The agent process encountered an error. ";
    case 2:
      return "The agent process received invalid input. ";
    case 126:
      return "The agent binary is not executable. ";
    case 127:
      return "The agent binary was not found. ";
    case 137:
      return "The agent process was killed (out of memory or timeout). ";
    case 143:
      return "The agent process was terminated. ";
    default:
      return `The agent process exited with code ${exitCode}. `;
  }
}
