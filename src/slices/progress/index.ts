import path from "node:path";
import { appendText, ensureDir } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import { ProgressEventSchema, type ProgressEventRecord } from "../../core/schemas.js";

export type ProgressEvent = ProgressEventRecord;
export type HarnessName = ProgressEvent["harness"];
export type ProgressPhase = ProgressEvent["phase"];

export interface ProgressUpdate {
  phase: ProgressPhase;
  status: string;
  sessionId?: string;
  tool?: string;
  elapsedMs?: number;
}

export interface ProgressReporter {
  emit(update: ProgressUpdate): void;
}

export interface ProgressReporterContext {
  threadKey: string;
  harness: HarnessName;
  attempt: number;
  sessionId?: string;
  artifactPath: string;
  now?: () => string;
  nowMs?: () => number;
}

export type ProgressArtifactWriter = (artifactPath: string, event: ProgressEvent) => Promise<void>;
export type ProgressListener = (event: ProgressEvent) => void;

const TERMINAL_PHASES = new Set<ProgressPhase>(["completed", "failed", "cancelled"]);
const MAX_STATUS_LENGTH = 240;
const MAX_TOOL_LENGTH = 80;

async function appendProgressArtifact(artifactPath: string, event: ProgressEvent): Promise<void> {
  await ensureDir(path.dirname(artifactPath));
  const validated = ProgressEventSchema.parse(event);
  await appendText(artifactPath, `${JSON.stringify(validated)}\n`);
}

function sanitize(value: string, maxLength: number): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export class ProgressStore {
  private readonly currentEvents = new Map<string, ProgressEvent>();
  private readonly terminalEvents = new Map<string, ProgressEvent>();
  private readonly attemptCounters = new Map<string, number>();
  private readonly listeners = new Set<ProgressListener>();
  private readonly artifactWrites = new Map<string, Promise<void>>();

  constructor(private readonly writeArtifact: ProgressArtifactWriter = appendProgressArtifact) {}

  beginAttempt(threadKey: string): number {
    const attempt = (this.attemptCounters.get(threadKey) ?? 0) + 1;
    this.attemptCounters.set(threadKey, attempt);
    return attempt;
  }

  createReporter(context: ProgressReporterContext): ProgressReporter {
    let sequence = 0;
    const startedAt = (context.nowMs ?? Date.now)();
    return {
      emit: (update) => {
        const event: ProgressEvent = {
          threadKey: context.threadKey,
          harness: context.harness,
          sessionId: update.sessionId ?? context.sessionId,
          attempt: context.attempt,
          sequence: ++sequence,
          at: (context.now ?? (() => new Date().toISOString()))(),
          phase: update.phase,
          status: sanitize(update.status || update.phase, MAX_STATUS_LENGTH),
          ...(update.tool ? { tool: sanitize(update.tool, MAX_TOOL_LENGTH) } : {}),
          elapsedMs: Math.max(0, update.elapsedMs ?? (context.nowMs ?? Date.now)() - startedAt),
        };
        this.publish(event, context.artifactPath);
      },
    };
  }

  current(threadKey: string): ProgressEvent | undefined {
    return this.currentEvents.get(threadKey);
  }

  allCurrent(): ProgressEvent[] {
    return [...this.currentEvents.values()];
  }

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: ProgressEvent, artifactPath: string): void {
    const previous = this.currentEvents.get(event.threadKey);
    const terminal = this.terminalEvents.get(event.threadKey);
    if (terminal && event.attempt <= terminal.attempt) return;
    if (
      previous &&
      (event.attempt < previous.attempt ||
        (event.attempt === previous.attempt && event.sequence <= previous.sequence))
    ) {
      return;
    }

    const previousWrite = this.artifactWrites.get(artifactPath) ?? Promise.resolve();
    const currentWrite = previousWrite
      .catch(() => undefined)
      .then(() => this.writeArtifact(artifactPath, event))
      .catch((error) => {
        log.warn("progress.artifact_write_failed", {
          thread_key: event.threadKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.artifactWrites.set(artifactPath, currentWrite);

    if (TERMINAL_PHASES.has(event.phase)) {
      this.currentEvents.delete(event.threadKey);
      this.terminalEvents.set(event.threadKey, event);
    } else {
      this.currentEvents.set(event.threadKey, event);
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn("progress.listener_failed", {
          thread_key: event.threadKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const progressStore = new ProgressStore();
