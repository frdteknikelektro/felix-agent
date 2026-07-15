import { describe, expect, it } from "vitest";
import { buildDecisionNotificationPrompt } from "../src/core/harness-common.js";

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
