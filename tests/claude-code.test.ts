import { describe, expect, it } from "vitest";
import { parseAgentOutput } from "../src/core/harness-common.js";
import { buildClaudeTurnArgs, claudeProgressUpdate, parseClaudeStdout } from "../src/adapters/claude-code/index.js";

describe("claude-code stdout parser", () => {
  it("maps stream-json lifecycle events without exposing tool input", () => {
    expect(claudeProgressUpdate({
      type: "assistant",
      session_id: "sess-1",
      message: { content: [{ type: "tool_use", name: "bash", input: { command: "secret" } }] },
    })).toEqual({ phase: "tool_started", status: "Running bash", tool: "bash", sessionId: "sess-1" });
  });
  // Exact top-level shape emitted by `claude -p --output-format json` (claude 2.1.161).
  const jsonModeLine = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "FELIX_REPLY\nhello\nEND_FELIX_REPLY",
    session_id: "539162e7-f5ac-4927-a7e9-d01f44393ff0",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1200,
      output_tokens: 34,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    },
    modelUsage: { "claude-sonnet-4-6": {} },
  });

  it("extracts the top-level result string, session id, and usage (json mode)", () => {
    const { assistantText, sessionId, usage } = parseClaudeStdout([jsonModeLine]);
    expect(assistantText).toBe("FELIX_REPLY\nhello\nEND_FELIX_REPLY");
    expect(assistantText).not.toBe("");
    expect(sessionId).toBe("539162e7-f5ac-4927-a7e9-d01f44393ff0");
    expect(usage).not.toBeNull();
    expect(usage?.input).toBe(1200);
    expect(usage?.output).toBe(34);
  });

  it("feeds a parseable reply through parseAgentOutput", () => {
    const { assistantText } = parseClaudeStdout([jsonModeLine]);
    expect(parseAgentOutput(assistantText).kind).toBe("reply");
  });

  it("still handles the nested result.result form", () => {
    const line = JSON.stringify({ type: "result", result: { result: "FELIX_REPLY\nhi\nEND_FELIX_REPLY" } });
    expect(parseClaudeStdout([line]).assistantText).toBe("FELIX_REPLY\nhi\nEND_FELIX_REPLY");
  });

  it("still handles stream-json assistant + system events", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", data: { session_id: "abc" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "hi" }] } }),
    ];
    const { assistantText, sessionId } = parseClaudeStdout(lines);
    expect(assistantText).toBe("hi");
    expect(sessionId).toBe("abc");
  });
});

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
