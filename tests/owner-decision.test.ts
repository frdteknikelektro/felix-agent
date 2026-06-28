import { describe, expect, it } from "vitest";
import { parseOwnerDecision, parseOwnerDecisionAsync, ownerDecisionFromAction } from "../src/slices/approvals/index.js";
import { loadConfig } from "../src/config.js";

describe("ownerDecisionFromAction", () => {
  it("maps the REST action + scope to a decision mode", () => {
    expect(ownerDecisionFromAction("approve", "once")).toBe("once");
    expect(ownerDecisionFromAction("approve", "always")).toBe("always");
    expect(ownerDecisionFromAction("approve", "anything-else")).toBe("once");
    expect(ownerDecisionFromAction("reject", "once")).toBe("reject");
    expect(ownerDecisionFromAction("reject", "always")).toBe("reject");
  });

  it("accepts a bare valid mode passed as the action", () => {
    expect(ownerDecisionFromAction("once", "once")).toBe("once");
    expect(ownerDecisionFromAction("always", "once")).toBe("always");
  });

  it("returns null for an unrecognised action", () => {
    expect(ownerDecisionFromAction("", "once")).toBeNull();
    expect(ownerDecisionFromAction("frobnicate", "once")).toBeNull();
  });
});

describe("parseOwnerDecision", () => {
  it("recognises the owner reply grammar, case- and space-insensitively", () => {
    expect(parseOwnerDecision("OK once")).toEqual({ mode: "once" });
    expect(parseOwnerDecision("  ok ONCE  ")).toEqual({ mode: "once" });
    expect(parseOwnerDecision("OK always")).toEqual({ mode: "always" });
    expect(parseOwnerDecision("reject")).toEqual({ mode: "reject" });
    expect(parseOwnerDecision("yes")).toEqual({ mode: "once" });
    expect(parseOwnerDecision("always")).toEqual({ mode: "always" });
    expect(parseOwnerDecision("no")).toEqual({ mode: "reject" });
    expect(parseOwnerDecision("👌")).toEqual({ mode: "once" });
    expect(parseOwnerDecision("👌 once")).toEqual({ mode: "once" });
    expect(parseOwnerDecision("👍")).toEqual({ mode: "always" });
    expect(parseOwnerDecision("👍 always")).toEqual({ mode: "always" });
    expect(parseOwnerDecision("🙏")).toEqual({ mode: "reject" });
  });

  it("returns null for anything that is not a decision", () => {
    expect(parseOwnerDecision("ok")).toBeNull();
    expect(parseOwnerDecision("OK once please")).toBeNull();
    expect(parseOwnerDecision("approve")).toBeNull();
    expect(parseOwnerDecision("")).toBeNull();
    expect(parseOwnerDecision("y")).toBeNull();
    expect(parseOwnerDecision("n")).toBeNull();
  });
});

describe("parseOwnerDecisionAsync", () => {
  const cfg = loadConfig({ WORKSPACE_DIR: "/tmp/felix-test", SECRET_ENV_FILE: "/tmp/no-secrets" });

  it("matches via regex before falling back to Codex", async () => {
    expect(await parseOwnerDecisionAsync("OK once", cfg)).toEqual({ mode: "once" });
    expect(await parseOwnerDecisionAsync("  reject  ", cfg)).toEqual({ mode: "reject" });
    expect(await parseOwnerDecisionAsync("OK always", cfg)).toEqual({ mode: "always" });
    expect(await parseOwnerDecisionAsync("yes", cfg)).toEqual({ mode: "once" });
    expect(await parseOwnerDecisionAsync("no", cfg)).toEqual({ mode: "reject" });
    expect(await parseOwnerDecisionAsync("👌", cfg)).toEqual({ mode: "once" });
  });

  it("returns null when regex fails and Codex is not configured", async () => {
    // No OPENAI_API_KEY → Codex classify returns null
    expect(await parseOwnerDecisionAsync("approve this please", cfg)).toBeNull();
    expect(await parseOwnerDecisionAsync("yes do it", cfg)).toBeNull();
    expect(await parseOwnerDecisionAsync("go ahead once", cfg)).toBeNull();
  });

  it("returns null for empty / unrelated messages even with fallback", async () => {
    expect(await parseOwnerDecisionAsync("hello", cfg)).toBeNull();
    expect(await parseOwnerDecisionAsync("", cfg)).toBeNull();
  });
});
