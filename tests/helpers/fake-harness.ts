import type { Harness, TurnInput, TurnResult } from "../../src/core/ports.js";

export class FakeHarness implements Harness {
  lastInput?: TurnInput;
  result: TurnResult = {
    sessionId: "fake-session-id",
    exitCode: 0,
    success: true,
    parsed: { kind: "reply", text: "ok" },
    logPath: "/dev/null",
  };

  async run(input: TurnInput): Promise<TurnResult> {
    this.lastInput = input;
    return this.result;
  }
}

/** A harness that records every `run` call into the provided array. Use
 * when a test needs to assert on the order or count of harness turns. */
export class RecordHarness implements Harness {
  readonly inputs: TurnInput[] = [];
  private counter = 0;

  async run(input: TurnInput): Promise<TurnResult> {
    this.inputs.push(input);
    this.counter += 1;
    return {
      sessionId: `s${this.counter}`,
      exitCode: 0,
      success: true,
      parsed: { kind: "reply", text: "ok" },
      logPath: "/dev/null",
    };
  }
}
