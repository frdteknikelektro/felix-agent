import type { ContactRecord, SessionQueueItem, SessionState, SkillRecord, UniversalEvent } from "../types.js";
import type { ThreadHandle } from "../slices/sessions/index.js";
import type { Harness, SourceAdapter, SourceTurnContext, TurnResult } from "./ports.js";
import {
  handleTurnOutcome,
  handleTurnRunError,
  type TurnOutcomePorts,
  type TurnOutcomeResult,
} from "./turn-outcome.js";

type TurnSourceAdapter = Pick<SourceAdapter, "getTurnContext" | "sendTyping">;

export interface TurnRunnerPorts extends Omit<TurnOutcomePorts, "runFormatCorrection"> {
  sourceAdapter(source: string): TurnSourceAdapter;
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
}

export type TurnRunnerResult =
  | { kind: "complete" }
  | { kind: "stopped" };

export class TurnRunner {
  constructor(
    private readonly harness: Harness,
    private readonly ports: TurnRunnerPorts,
  ) {}

  async run(input: TurnRunnerInput): Promise<TurnRunnerResult> {
    const adapter = this.ports.sourceAdapter(input.event.source);
    const sourceContext = await adapter.getTurnContext({ event: input.event });
    let resumed = Boolean(input.session.harness_session_id);
    let retriedFreshStart = false;

    while (true) {
      if (this.ports.isStopRequested(input.thread.state.thread_key)) {
        return { kind: "stopped" };
      }

      let result: TurnResult;
      try {
        result = await this.runWithTyping(input, adapter, sourceContext, resumed);
      } catch (error) {
        const outcome = await handleTurnRunError({
          thread: input.thread,
          event: input.event,
          item: input.item,
          error,
          retryCounts: input.retryCounts,
          ports: this.outcomePorts(input, sourceContext),
        });
        return this.resultFromOutcome(outcome);
      }

      if (this.ports.isStopRequested(input.thread.state.thread_key)) {
        return { kind: "stopped" };
      }

      const outcome = await handleTurnOutcome({
        thread: input.thread,
        event: input.event,
        item: input.item,
        contact: input.contact,
        result,
        resumed,
        retriedFreshStart,
        retryCounts: input.retryCounts,
        ports: this.outcomePorts(input, sourceContext),
      });
      if (outcome.kind === "retry_fresh") {
        resumed = outcome.resumed;
        retriedFreshStart = outcome.retriedFreshStart;
        continue;
      }
      return this.resultFromOutcome(outcome);
    }
  }

  private async runWithTyping(
    input: TurnRunnerInput,
    adapter: TurnSourceAdapter,
    sourceContext: SourceTurnContext,
    resumed: boolean,
  ): Promise<TurnResult> {
    const typingInterval = setInterval(() => {
      adapter.sendTyping({ event: input.event }).catch(() => {});
    }, 100);
    try {
      return await this.harness.run(this.turnInput(input, sourceContext, resumed));
    } finally {
      clearInterval(typingInterval);
    }
  }

  private outcomePorts(input: TurnRunnerInput, sourceContext: SourceTurnContext): TurnOutcomePorts {
    return {
      ...this.ports,
      runFormatCorrection: async (promptOverride) => this.harness.run({
        ...this.turnInput(input, sourceContext, true),
        promptOverride,
      }),
    };
  }

  private turnInput(
    input: TurnRunnerInput,
    sourceContext: SourceTurnContext,
    resumed: boolean,
  ): Parameters<Harness["run"]>[0] {
    return {
      thread: input.thread,
      event: input.event,
      eventFile: input.item.event_file,
      contact: input.contact,
      skills: input.skills,
      sourceContext,
      resumed,
      precedingEvents: input.precedingEvents.length > 0 ? input.precedingEvents : undefined,
      signal: input.signal,
    };
  }

  private resultFromOutcome(
    outcome: Extract<TurnOutcomeResult, { kind: "complete" | "stopped" }>,
  ): TurnRunnerResult {
    if (outcome.kind === "stopped") return { kind: "stopped" };
    return { kind: "complete" };
  }
}
