import { describe, expect, it } from "vitest";
import {
  buildDecisionNotificationPrompt,
  parseAgentOutput,
} from "../src/core/harness-common.js";

describe("decision notification prompt", () => {
  it("uses the configured agent name", () => {
    const prompt = buildDecisionNotificationPrompt({
      thread: {} as never,
      mode: "once",
      skillId: "database",
      reason: "needed",
      agentName: "Nova",
    });

    expect(prompt).toContain("You are Nova, replying in a conversation thread.");
    expect(prompt).not.toContain("You are Felix, replying");
  });
});

describe("parseAgentOutput", () => {
  it("keeps ordinary FELIX_REPLY parsing as a normal reply", () => {
    expect(parseAgentOutput("FELIX_REPLY\nHello there.\nEND_FELIX_REPLY")).toEqual({
      kind: "reply",
      text: "Hello there.",
    });
  });
});
