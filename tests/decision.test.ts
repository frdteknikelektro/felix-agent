import { describe, expect, it } from "vitest";
import { parseDecisionToken, parseDecisionEmoji, decisionEmoji, decisionLabel } from "../src/core/decision.js";

describe("parseDecisionToken", () => {
  it("recognizes literal token strings", () => {
    expect(parseDecisionToken("once")).toBe("once");
    expect(parseDecisionToken("always")).toBe("always");
    expect(parseDecisionToken("reject")).toBe("reject");
  });

  it("is case-insensitive", () => {
    expect(parseDecisionToken("ONCE")).toBe("once");
    expect(parseDecisionToken("Always")).toBe("always");
    expect(parseDecisionToken("REJECT")).toBe("reject");
  });

  it("handles whitespace", () => {
    expect(parseDecisionToken("  once  ")).toBe("once");
    expect(parseDecisionToken("\talways\n")).toBe("always");
  });

  it("falls back to emoji parsing for unknown tokens", () => {
    expect(parseDecisionToken("👌")).toBe("once");
    expect(parseDecisionToken("👍")).toBe("always");
    expect(parseDecisionToken("🙏")).toBe("reject");
  });

  it("handles colon-wrapped emoji tokens", () => {
    expect(parseDecisionToken(":thumbsup:")).toBe("always");
    expect(parseDecisionToken(":pray:")).toBe("reject");
    expect(parseDecisionToken(":ok_hand:")).toBe("once");
  });

  it("returns null for unrecognized input", () => {
    expect(parseDecisionToken("")).toBeNull();
    expect(parseDecisionToken("hello")).toBeNull();
    expect(parseDecisionToken("🤖")).toBeNull();
  });
});

describe("parseDecisionEmoji", () => {
  it("resolves direct emoji", () => {
    expect(parseDecisionEmoji("👌")).toBe("once");
    expect(parseDecisionEmoji("👍")).toBe("always");
    expect(parseDecisionEmoji("🙏")).toBe("reject");
  });

  it("resolves named aliases", () => {
    expect(parseDecisionEmoji("ok_hand")).toBe("once");
    expect(parseDecisionEmoji("ok hand")).toBe("once");
    expect(parseDecisionEmoji("okhand")).toBe("once");
    expect(parseDecisionEmoji("thumbsup")).toBe("always");
    expect(parseDecisionEmoji("thumbs_up")).toBe("always");
    expect(parseDecisionEmoji("+1")).toBe("always");
    expect(parseDecisionEmoji("thumbs up")).toBe("always");
    expect(parseDecisionEmoji("thumb")).toBe("always");
    expect(parseDecisionEmoji("pray")).toBe("reject");
    expect(parseDecisionEmoji("prayer")).toBe("reject");
    expect(parseDecisionEmoji("folded_hands")).toBe("reject");
    expect(parseDecisionEmoji("folded hands")).toBe("reject");
  });

  it("strips colon wrapping", () => {
    expect(parseDecisionEmoji(":thumbsup:")).toBe("always");
    expect(parseDecisionEmoji(":ok_hand:")).toBe("once");
    expect(parseDecisionEmoji(":pray:")).toBe("reject");
  });

  it("takes first word for unknown multi-word tokens", () => {
    // Unknown multi-word input with no DECISION_ALIASES match for any word → null
    expect(parseDecisionEmoji("hello world")).toBeNull();
  });

  it("returns null for unknown emoji", () => {
    expect(parseDecisionEmoji("")).toBeNull();
    expect(parseDecisionEmoji("unknown")).toBeNull();
    expect(parseDecisionEmoji("❤️")).toBeNull();
  });
});

describe("decisionEmoji", () => {
  it("maps modes to display emoji", () => {
    expect(decisionEmoji("once")).toBe("👌");
    expect(decisionEmoji("always")).toBe("👍");
    expect(decisionEmoji("reject")).toBe("🙏");
  });
});

describe("decisionLabel", () => {
  it("maps modes to display labels", () => {
    expect(decisionLabel("once")).toBe("Once");
    expect(decisionLabel("always")).toBe("Always");
    expect(decisionLabel("reject")).toBe("Reject");
  });
});
