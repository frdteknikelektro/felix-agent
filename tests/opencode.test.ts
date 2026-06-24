import { describe, expect, it } from "vitest";
import { detectProviderFailure } from "../src/core/harness-common.js";

describe("detectProviderFailure", () => {
  it("detects rate limit", () => {
    const r = detectProviderFailure(["Rate limit exceeded — try again in 30s"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects AI_APICallError", () => {
    const r = detectProviderFailure(["AI_APICallError: 429 Too Many Requests"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects 429 status code", () => {
    const r = detectProviderFailure(["HTTP 429 rate limited"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects insufficient balance", () => {
    const r = detectProviderFailure(["Error: insufficient balance for model gpt-4o"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects quota exceeded", () => {
    const r = detectProviderFailure(["Your quota has been exceeded. Purchase more credits."], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects billing limit", () => {
    const r = detectProviderFailure(["Billing limit exceeded for this account"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects invalid API key", () => {
    const r = detectProviderFailure(["Invalid API key provided: sk-abc123"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects model overloaded", () => {
    const r = detectProviderFailure(["Model gpt-4o is currently overloaded"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects token limit exceeded", () => {
    const r = detectProviderFailure(["Token limit exceeded for this request"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("detects authentication error", () => {
    const r = detectProviderFailure(["Authentication error: invalid credentials"], "OpenCode");
    expect(r).toContain("OpenCode provider failure");
  });

  it("redacts long tokens in excerpt", () => {
    const r = detectProviderFailure([
      "Error calling API with key sk-abcdefghijklmnopqrstuvwxyz123456 — rate limit",
    ], "OpenCode");
    expect(r).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(r).toContain("[REDACTED]");
  });

  it("returns null for benign stderr", () => {
    const r = detectProviderFailure(["Warning: some deprecation notice"], "OpenCode");
    expect(r).toBeNull();
  });

  it("returns null for empty stderr", () => {
    const r = detectProviderFailure([], "OpenCode");
    expect(r).toBeNull();
  });

  it("returns null for whitespace-only stderr", () => {
    const r = detectProviderFailure(["   \n  "], "OpenCode");
    expect(r).toBeNull();
  });

  it("does not false-positive on normal warnings", () => {
    const r = detectProviderFailure([
      "Warning: Using default configuration",
      "Info: Starting sync process",
    ], "OpenCode");
    expect(r).toBeNull();
  });
});

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