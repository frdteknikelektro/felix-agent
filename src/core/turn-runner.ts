import type {
  ContactRecord,
  SessionQueueItem,
  SessionState,
  SkillRecord,
  UniversalEvent,
} from "../types.js";
import type { ThreadHandle } from "../slices/sessions/index.js";
import type {
  Harness,
  ProgressReporter,
  ProgressUpdate,
  SourceAdapter,
  SourceTurnContext,
  TurnResult,
} from "./ports.js";
import {
  handleTurnOutcome,
  handleTurnRunError,
  type TurnOutcomePorts,
  type TurnOutcomeResult,
} from "./turn-outcome.js";
import { isOwnerMessage } from "./routing.js";

type TurnSourceAdapter = Pick<
  SourceAdapter,
  "ownerUserId" | "getTurnContext" | "sendTyping"
>;

export interface TurnRunnerPorts extends Omit<
  TurnOutcomePorts,
  "runFormatCorrection"
> {
  sourceAdapter(source: string): TurnSourceAdapter;
  progressReporter?(thread: ThreadHandle): ProgressReporter | undefined;
}

export interface TurnRunnerInput {
  thread: ThreadHandle;
  item: SessionQueueItem;
  session: SessionState;
  event: UniversalEvent;
  precedingEvents: { event: UniversalEvent; eventFile: string }[];
  contact: ContactRecord;
  skills: SkillRecord[];
  signal: AbortSignal;
  retryCounts: Map<string, number>;
  modelOverride?: string;
  propagateRunErrors?: boolean;
}

export type TurnRunnerResult =
  | { kind: "complete"; result?: TurnResult }
  | { kind: "stopped"; result?: TurnResult };

export class TurnRunner {
  constructor(
    private readonly harness: Harness,
    private readonly ports: TurnRunnerPorts,
  ) {}

  async run(input: TurnRunnerInput): Promise<TurnRunnerResult> {
    const adapter = this.ports.sourceAdapter(input.event.source);
    const sourceContext = await adapter.getTurnContext({ event: input.event });
    const requesterIsOwner = isOwnerMessage(
      input.event,
      input.event.source,
      adapter.ownerUserId,
    );
    let resumed = Boolean(input.session.harness_session_id);
    let retriedFreshStart = false;

    while (true) {
      if (this.ports.isStopRequested(input.thread.state.thread_key)) {
        return { kind: "stopped" };
      }

      let result: TurnResult;
      const progress = this.ports.progressReporter?.(input.thread);
      let terminalProgress = progress;
      let terminalEmitted = false;
      const emitTerminal = (update: ProgressUpdate): void => {
        if (terminalEmitted) return;
        terminalProgress?.emit(update);
        terminalEmitted = true;
      };
      progress?.emit({
        phase: "started",
        status: resumed ? "Resuming harness turn" : "Starting harness turn",
      });
      const outcomePorts = this.outcomePorts(
        input,
        sourceContext,
        requesterIsOwner,
        progress,
        (correctionProgress) => {
          terminalProgress = correctionProgress;
          terminalEmitted = false;
        },
        () => emitTerminal({ phase: "failed", status: "Format correction failed" }),
      );
      try {
        result = await this.runWithTyping(
          input,
          adapter,
          sourceContext,
          requesterIsOwner,
          resumed,
          progress,
        );
      } catch (error) {
        emitTerminal({
          phase: this.ports.isStopRequested(input.thread.state.thread_key) ? "cancelled" : "failed",
          status: this.ports.isStopRequested(input.thread.state.thread_key)
            ? "Turn cancelled"
            : "Harness turn failed",
        });
        if (input.propagateRunErrors) throw error;
        const outcome = await handleTurnRunError({
          thread: input.thread,
          event: input.event,
          item: input.item,
          error,
          retryCounts: input.retryCounts,
          ports: outcomePorts,
        });
        return this.resultFromOutcome(outcome, undefined, false);
      }

      if (this.ports.isStopRequested(input.thread.state.thread_key)) {
        emitTerminal({ phase: "cancelled", status: "Turn cancelled" });
        return { kind: "stopped" };
      }

      const outcome = await handleTurnOutcome({
        thread: input.thread,
        event: input.event,
        item: input.item,
        contact: input.contact,
        skills: input.skills,
        result,
        resumed,
        retriedFreshStart,
        retryCounts: input.retryCounts,
        ports: outcomePorts,
      });
      if (outcome.kind === "retry_fresh") {
        emitTerminal({ phase: "failed", status: "Retrying with a fresh harness attempt" });
        resumed = outcome.resumed;
        retriedFreshStart = outcome.retriedFreshStart;
        continue;
      }
      if (outcome.kind === "stopped") {
        emitTerminal({ phase: "cancelled", status: "Turn cancelled" });
        return { kind: "stopped" };
      }
      const finalResult = outcome.result ?? result;
      emitTerminal({
        phase: finalResult.parsed.kind === "permission_required" ? "waiting_permission" : finalResult.success ? "completed" : "failed",
        status: finalResult.parsed.kind === "permission_required"
          ? "Waiting for permission"
          : finalResult.success
            ? "Turn completed"
            : "Turn failed",
        sessionId: finalResult.sessionId,
      });
      return this.resultFromOutcome(
        outcome,
        result,
        Boolean(input.propagateRunErrors),
      );
    }
  }

  private async runWithTyping(
    input: TurnRunnerInput,
    adapter: TurnSourceAdapter,
    sourceContext: SourceTurnContext,
    requesterIsOwner: boolean,
    resumed: boolean,
    progress?: ProgressReporter,
  ): Promise<TurnResult> {
    const typingInterval = setInterval(() => {
      adapter.sendTyping({ event: input.event }).catch(() => {});
    }, 100);
    try {
      return await this.harness.run(
        this.turnInput(
          input,
          sourceContext,
          requesterIsOwner,
          resumed,
          progress,
        ),
      );
    } finally {
      clearInterval(typingInterval);
    }
  }

  private outcomePorts(
    input: TurnRunnerInput,
    sourceContext: SourceTurnContext,
    requesterIsOwner: boolean,
    progress?: ProgressReporter,
    onCorrectionProgress?: (progress: ProgressReporter) => void,
    onCorrectionFailure?: () => void,
  ): TurnOutcomePorts {
    return {
      ...this.ports,
      runFormatCorrection: async (promptOverride) => {
        progress?.emit({ phase: "failed", status: "Format error; retrying correction" });
        const correctionProgress = this.ports.progressReporter?.(input.thread);
        if (correctionProgress) {
          onCorrectionProgress?.(correctionProgress);
          correctionProgress.emit({ phase: "started", status: "Correcting harness output" });
        }
        try {
          return await this.harness.run({
            ...this.turnInput(
              input,
              sourceContext,
              requesterIsOwner,
              true,
              correctionProgress,
            ),
            promptOverride,
          });
        } catch (error) {
          onCorrectionFailure?.();
          throw error;
        }
      },
    };
  }

  private turnInput(
    input: TurnRunnerInput,
    sourceContext: SourceTurnContext,
    requesterIsOwner: boolean,
    resumed: boolean,
    progress?: ProgressReporter,
  ): Parameters<Harness["run"]>[0] {
    return {
      thread: input.thread,
      event: input.event,
      eventFile: input.item.event_file,
      contact: input.contact,
      skills: input.skills,
      sourceContext,
      requesterIsOwner,
      resumed,
      precedingEvents:
        input.precedingEvents.length > 0 ? input.precedingEvents : undefined,
      signal: input.signal,
      modelOverride: input.modelOverride,
      progress,
    };
  }

  private resultFromOutcome(
    outcome: Extract<TurnOutcomeResult, { kind: "complete" | "stopped" }>,
    result?: TurnResult,
    includeResult = false,
  ): TurnRunnerResult {
    if (!includeResult) return { kind: outcome.kind };
    if (outcome.kind === "stopped")
      return { kind: "stopped", result: outcome.result ?? result };
    return { kind: "complete", result: outcome.result ?? result };
  }
}
