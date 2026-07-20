import type { DashboardSnapshot, ProgressEvent } from "./types.js";

export type ProgressState = Record<string, ProgressEvent | null>;
export interface ProgressClientState {
  progressByThread: ProgressState;
  terminalAttempts: Record<string, { attempt: number; sequence: number }>;
}

const TERMINAL_PROGRESS_PHASES = new Set(["completed", "failed", "cancelled"]);

export function applyProgressEvent(current: ProgressClientState, event: ProgressEvent): ProgressClientState {
  const previous = current.progressByThread[event.threadKey];
  if (
    previous &&
    (event.attempt < previous.attempt ||
      (event.attempt === previous.attempt && event.sequence <= previous.sequence))
  ) return current;

  const terminalAttempt = current.terminalAttempts[event.threadKey];
  if (
    terminalAttempt &&
    (event.attempt < terminalAttempt.attempt ||
      (event.attempt === terminalAttempt.attempt && event.sequence <= terminalAttempt.sequence))
  ) return current;
  if (terminalAttempt && event.attempt === terminalAttempt.attempt && !TERMINAL_PROGRESS_PHASES.has(event.phase)) {
    return current;
  }

  const progressByThread = {
    ...current.progressByThread,
    [event.threadKey]: TERMINAL_PROGRESS_PHASES.has(event.phase) ? null : event,
  };
  const terminalAttempts = { ...current.terminalAttempts };
  if (TERMINAL_PROGRESS_PHASES.has(event.phase)) {
    terminalAttempts[event.threadKey] = { attempt: event.attempt, sequence: event.sequence };
  }
  else delete terminalAttempts[event.threadKey];
  return { progressByThread, terminalAttempts };
}

export function progressStateFromSnapshot(
  snapshot: DashboardSnapshot,
  previous: ProgressClientState,
): ProgressClientState {
  const next: ProgressState = Object.fromEntries(
    snapshot.activeSessionList.flatMap((session) => (
      session.currentProgress ? [[session.threadKey, session.currentProgress]] as const : []
    )),
  );
  for (const [threadKey, snapshotProgress] of Object.entries(next)) {
    if (!snapshotProgress) continue;
    const previousProgress = previous.progressByThread[threadKey];
    if (
      previousProgress &&
      (snapshotProgress.attempt < previousProgress.attempt ||
        (snapshotProgress.attempt === previousProgress.attempt && snapshotProgress.sequence <= previousProgress.sequence))
    ) {
      next[threadKey] = previousProgress;
    }
  }
  const terminalAttempts = { ...previous.terminalAttempts };
  for (const [threadKey, watermark] of Object.entries(previous.terminalAttempts)) {
    const snapshotProgress = next[threadKey];
    if (!snapshotProgress || snapshotProgress.attempt <= watermark.attempt) {
      next[threadKey] = null;
    } else {
      delete terminalAttempts[threadKey];
    }
  }
  return { progressByThread: next, terminalAttempts };
}
