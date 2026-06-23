import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAgentOutput } from "../src/core/harness-common.js";
import { decideTurnResult } from "../src/core/decide-turn.js";
import type { ParsedAgentOutput, TurnResult } from "../src/core/ports.js";

// These tests close the gap that let the broken refactor ship green: the old
// guards only asserted the contract *text existed*. Here we extract the block
// shapes straight from AGENTS.md, fill the placeholders, and run them through
// the real parser + decision path — so a drift between what AGENTS.md tells the
// model to emit and what parseAgentOutput accepts fails CI.

const agentsMd = readFileSync(path.resolve(import.meta.dirname, "../AGENTS.md"), "utf8");

/** Pull the fenced block between `start` and `end` (inclusive) out of AGENTS.md. */
function documentedBlock(start: string, end: string): string {
  const from = agentsMd.indexOf(start);
  const to = agentsMd.indexOf(end, from);
  expect(from, `AGENTS.md must document a ${start} block`).toBeGreaterThanOrEqual(0);
  expect(to, `AGENTS.md must document ${end}`).toBeGreaterThan(from);
  return agentsMd.slice(from, to + end.length);
}

function makeResult(parsed: ParsedAgentOutput): TurnResult {
  return { sessionId: "s", exitCode: 0, success: true, parsed } as TurnResult;
}

describe("contract round-trip (AGENTS.md ↔ parser ↔ decision)", () => {
  it("the documented FELIX_REPLY block parses as a reply and routes to reply", () => {
    const block = documentedBlock("FELIX_REPLY\n<reply text>", "END_FELIX_REPLY").replace(
      "<reply text>",
      "Hola, listo.",
    );
    const parsed = parseAgentOutput(block);
    expect(parsed.kind).toBe("reply");
    expect(parsed.text).toBe("Hola, listo.");
    expect(decideTurnResult(makeResult(parsed), false, false).kind).toBe("reply");
  });

  it("the documented PERMISSION_REQUIRED block parses and routes to permission_required", () => {
    const block = documentedBlock("PERMISSION_REQUIRED\nskill:", "END_PERMISSION_REQUIRED")
      .replace("<skill id>", "deploy")
      .replace("<permission>", "deploy:run")
      .replace("<short reason>", "ship the build")
      .replace("<short owner request>", "approve deploy");
    // Per the contract, a user-facing reply precedes the block.
    const output = `FELIX_REPLY\nPidiendo permiso.\nEND_FELIX_REPLY\n\n${block}`;

    const parsed = parseAgentOutput(output);
    expect(parsed.kind).toBe("permission_required");
    if (parsed.kind === "permission_required") {
      expect(parsed.skillId).toBe("deploy");
      expect(parsed.permissions).toContain("deploy:run");
      expect(parsed.text).toBe("Pidiendo permiso.");
    }
    expect(decideTurnResult(makeResult(parsed), false, false).kind).toBe("permission_required");
  });

  it("a malformed permission block is caught and routes to a format retry", () => {
    // Missing the permissions list — the parser must reject, not silently pass.
    const bad = "PERMISSION_REQUIRED\nskill: deploy\nreason: x\nEND_PERMISSION_REQUIRED";
    const parsed = parseAgentOutput(bad);
    expect(parsed.kind).toBe("format_error");
    expect(decideTurnResult(makeResult(parsed), false, false).kind).toBe("format_retry");
  });
});
