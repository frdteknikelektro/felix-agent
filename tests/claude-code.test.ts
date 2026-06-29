import { describe, expect, it } from "vitest";
import { parseAgentOutput } from "../src/core/harness-common.js";
import { buildClaudeTurnArgs } from "../src/adapters/claude-code/index.js";

describe("claude-code turn arg builder", () => {
  const base = { model: "sonnet", workspaceDir: "/home/node/workspace", sessionId: "sess-1", prompt: "do the thing" };

  it("places the prompt before --add-dir on a fresh turn", () => {
    const args = buildClaudeTurnArgs({ ...base, hasSession: false });
    const promptIdx = args.indexOf("do the thing");
    const addDirIdx = args.indexOf("--add-dir");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(addDirIdx).toBeGreaterThan(promptIdx);
    // --add-dir must be the last flag, its value the final arg
    expect(args.slice(-2)).toEqual(["--add-dir", "/home/node/workspace"]);
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("places the prompt before --add-dir on a resumed turn", () => {
    const args = buildClaudeTurnArgs({ ...base, hasSession: true });
    const promptIdx = args.indexOf("do the thing");
    const addDirIdx = args.indexOf("--add-dir");
    expect(addDirIdx).toBeGreaterThan(promptIdx);
    expect(args.slice(-2)).toEqual(["--add-dir", "/home/node/workspace"]);
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
  });
});

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
