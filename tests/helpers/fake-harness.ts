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
