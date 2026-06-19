import { describe, expect, it } from "vitest";
import { decideTurnResult } from "../src/core/decide-turn.js";
import type { TurnResult } from "../src/core/ports.js";

function makeResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "sess-1",
    exitCode: 0,
    success: true,
    parsed: { kind: "reply", text: "hello" },
    logPath: "/dev/null",
    ...overrides,
  };
}

describe("decideTurnResult", () => {
  it("retry_fresh when resumed + first failure", () => {
    const result = makeResult({ success: false, exitCode: 1 });
    expect(decideTurnResult(result, true, false).kind).toBe("retry_fresh");
  });

  it("fail when resumed + already retried fresh", () => {
    const result = makeResult({ success: false, exitCode: 1 });
    expect(decideTurnResult(result, true, true).kind).toBe("fail");
  });

  it("fail on first attempt failure (not resumed)", () => {
    const result = makeResult({ success: false, exitCode: 1 });
    expect(decideTurnResult(result, false, false).kind).toBe("fail");
  });

  it("reply on successful reply output", () => {
    const result = makeResult({ parsed: { kind: "reply", text: "hi" } });
    expect(decideTurnResult(result, false, false).kind).toBe("reply");
  });

  it("no_skill on no_skill output", () => {
    const result = makeResult({ parsed: { kind: "no_skill", text: "I don't have the skill yet." } });
    expect(decideTurnResult(result, false, false).kind).toBe("no_skill");
  });

  it("permission_required on permission_required output", () => {
    const result = makeResult({
      parsed: { kind: "permission_required", text: "...", permissions: ["shell.run"] },
    });
    expect(decideTurnResult(result, false, false).kind).toBe("permission_required");
  });

  it("fallback on unknown output", () => {
    const result = makeResult({ parsed: { kind: "unknown", text: "???" } });
    expect(decideTurnResult(result, false, false).kind).toBe("fallback");
  });

  it("format_retry on format_error output", () => {
    const result = makeResult({ parsed: { kind: "format_error", text: "malformed" } });
    expect(decideTurnResult(result, false, false).kind).toBe("format_retry");
  });

  it("retry_fresh takes precedence over output kind when resumed+first-fail", () => {
    // Even if the harness somehow returned a parsed reply with success=false, the
    // resume-retry path fires first.
    const result = makeResult({ success: false, exitCode: 1, parsed: { kind: "reply", text: "x" } });
    expect(decideTurnResult(result, true, false).kind).toBe("retry_fresh");
  });
});
