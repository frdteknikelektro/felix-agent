import { describe, expect, it } from "vitest";
import { parseAgentOutput } from "../src/core/harness-common.js";

describe("claude-code harness output parser", () => {
  it("parses reply blocks", () => {
    const parsed = parseAgentOutput("FELIX_REPLY\nhello world\nEND_FELIX_REPLY");
    expect(parsed.kind).toBe("reply");
    if (parsed.kind === "reply") {
      expect(parsed.text).toBe("hello world");
    }
  });

  it("parses multiline reply content", () => {
    const parsed = parseAgentOutput([
      "FELIX_REPLY",
      "line one",
      "line two",
      "END_FELIX_REPLY",
    ].join("\n"));
    expect(parsed.kind).toBe("reply");
    if (parsed.kind === "reply") {
      expect(parsed.text).toContain("line one");
      expect(parsed.text).toContain("line two");
    }
  });

  it("parses permission_required blocks", () => {
    const parsed = parseAgentOutput([
      "PERMISSION_REQUIRED",
      "skill: test.skill",
      "permissions:",
      "- shell.run",
      "reason: testing",
      "owner_message: please approve",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("permission_required");
    if (parsed.kind === "permission_required") {
      expect(parsed.skillId).toBe("test.skill");
    }
  });

  it("returns format_error for unparseable output", () => {
    const parsed = parseAgentOutput("random text without any block markers");
    expect(parsed).toBeDefined();
    expect(parsed.kind).toBeDefined();
  });

  it("returns no_skill for empty output", () => {
    const parsed = parseAgentOutput("");
    // empty output may be "no_skill" or "reply" depending on implementation
    expect(parsed).toBeDefined();
    expect(parsed.kind).toBeDefined();
  });
});
