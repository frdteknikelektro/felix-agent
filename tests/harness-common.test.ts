import { describe, expect, it } from "vitest";
import {
  buildDecisionNotificationPrompt,
  parseAgentOutput,
} from "../src/core/harness-common.js";

describe("personality change output", () => {
  it("parses an update proposal without losing its Markdown", () => {
    const output = parseAgentOutput(`FELIX_REPLY
I prepared a warmer personality.
END_FELIX_REPLY
PERSONALITY_CHANGE
mode: update
content:
# Personality

## Role

Personal secretary and assistant

## Tone

- Warm and concise

## Communication Style

- Professional
END_PERSONALITY_CHANGE`);

    expect(output).toEqual({
      kind: "personality_change",
      text: "I prepared a warmer personality.",
      personalityMode: "update",
      personalityContent: `# Personality

## Role

Personal secretary and assistant

## Tone

- Warm and concise

## Communication Style

- Professional`,
    });
  });

  it("requests personality-specific correction for a malformed proposal", () => {
    const output = parseAgentOutput(`FELIX_REPLY
I prepared the change.
END_FELIX_REPLY
PERSONALITY_CHANGE
mode: update
END_PERSONALITY_CHANGE`);

    expect(output.kind).toBe("format_error");
    expect(output.formatTarget).toBe("personality_change");
    expect(output.text).toContain("content:");
  });
});

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
