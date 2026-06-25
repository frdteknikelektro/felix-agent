import { describe, expect, it } from "vitest";

// Also test the harness output parser (existing tests)
import { parseAgentOutput } from "../src/core/harness-common.js";

describe("parseAgentOutput", () => {
  it("parses reply blocks", () => {
    const parsed = parseAgentOutput("FELIX_REPLY\nhello\nEND_FELIX_REPLY");
    expect(parsed.kind).toBe("reply");
    if (parsed.kind === "reply") {
      expect(parsed.text).toContain("hello");
    }
  });

  it("parses permission_required with all fields", () => {
    const parsed = parseAgentOutput([
      "PERMISSION_REQUIRED",
      "skill: repo.fix",
      "permissions:",
      "- repo.write",
      "reason: needs write access",
      "owner_message: ask owner",
      "END_PERMISSION_REQUIRED",
    ].join("\n"));
    expect(parsed.kind).toBe("permission_required");
    if (parsed.kind === "permission_required") {
      expect(parsed.skillId).toBe("repo.fix");
      expect(parsed.permissions).toEqual(["repo.write"]);
    }
  });

  it("preserves text before permission block", () => {
    const parsed = parseAgentOutput("Please wait.\n\nPERMISSION_REQUIRED\nskill: s\npermissions:\n- p\nreason: r\nowner_message: m\nEND_PERMISSION_REQUIRED");
    expect(parsed.kind).toBe("permission_required");
    expect(parsed.text).toBe("Please wait.");
  });

  it("parses format_error for malformed blocks", () => {
    const parsed = parseAgentOutput("FELIX_REPLY\nincomplete");
    expect(parsed.kind).toBeDefined();
    expect(["format_error", "no_skill", "reply", "unknown"]).toContain(parsed.kind);
  });
});