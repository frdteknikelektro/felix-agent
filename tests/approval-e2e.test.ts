import { describe, expect, it } from "vitest";
import { parseOwnerDecisionAsync } from "../src/slices/approvals/index.js";
import { parseDecisionToken } from "../src/core/decision.js";
import { loadConfig } from "../src/config.js";

describe("Permission approval end-to-end", () => {
  const cfg = loadConfig({ WORKSPACE_DIR: "/tmp/felix-test-e2e", SECRET_ENV_FILE: "/tmp/no-secrets" });

  describe("decision token → mode mapping", () => {
    it("emoji reaction 👌 → once", () => {
      expect(parseDecisionToken("👌")).toBe("once");
    });

    it("emoji reaction 👍 → always", () => {
      expect(parseDecisionToken("👍")).toBe("always");
    });

    it("emoji reaction 🙏 → reject", () => {
      expect(parseDecisionToken("🙏")).toBe("reject");
    });

    it("text reply yes → once (regex path)", () => {
      expect(parseDecisionToken("yes")).toBeNull(); // "yes" is not a decision token, handled by parseOwnerDecision
    });

    it("full text yes parsed by parseOwnerDecisionAsync", async () => {
      const result = await parseOwnerDecisionAsync("yes", cfg);
      expect(result).toEqual({ mode: "once" });
    });

    it("full text no parsed by parseOwnerDecisionAsync", async () => {
      const result = await parseOwnerDecisionAsync("no", cfg);
      expect(result).toEqual({ mode: "reject" });
    });

    it("full text always parsed by parseOwnerDecisionAsync", async () => {
      const result = await parseOwnerDecisionAsync("always", cfg);
      expect(result).toEqual({ mode: "always" });
    });

    it("full text OK once parsed by parseOwnerDecisionAsync", async () => {
      const result = await parseOwnerDecisionAsync("OK once", cfg);
      expect(result).toEqual({ mode: "once" });
    });

    it("non-decision text returns null", async () => {
      const result = await parseOwnerDecisionAsync("hello world", cfg);
      expect(result).toBeNull();
    });
  });
});
