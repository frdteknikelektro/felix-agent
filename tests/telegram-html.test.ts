import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "../src/adapters/telegram/index.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold", () => {
    expect(markdownToTelegramHtml("*bold*")).toBe("<b>bold</b>");
  });

  it("converts italic", () => {
    expect(markdownToTelegramHtml("_italic_")).toBe("<i>italic</i>");
  });

  it("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~strike~")).toBe("<s>strike</s>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("converts code block", () => {
    expect(markdownToTelegramHtml("```block```")).toBe("<pre>block</pre>");
  });

  it("converts link", () => {
    expect(markdownToTelegramHtml("[text](https://example.com)")).toBe(
      '<a href="https://example.com">text</a>',
    );
  });

  it("escapes HTML entities in plain text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("escapes HTML inside formatting", () => {
    expect(markdownToTelegramHtml("*a < b*")).toBe("<b>a &lt; b</b>");
  });

  it("handles nested bold+italic", () => {
    expect(markdownToTelegramHtml("*bold _italic_*")).toBe("<b>bold <i>italic</i></b>");
  });

  it("handles unmatched bold as plain text", () => {
    expect(markdownToTelegramHtml("*unmatched")).toBe("*unmatched");
  });

  it("handles unmatched italic as plain text", () => {
    expect(markdownToTelegramHtml("_unmatched")).toBe("_unmatched");
  });

  it("handles mixed formatted and plain text", () => {
    expect(markdownToTelegramHtml("Hello *bold* world")).toBe("Hello <b>bold</b> world");
  });

  it("handles text with special chars that caused the original error", () => {
    const input = "Here's the result. The file was updated (v2.1) — check it out! A < B & C > D";
    const result = markdownToTelegramHtml(input);
    expect(result).not.toContain("<b>");
    expect(result).not.toContain("<i>");
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
  });

  it("handles code block with special chars unescaped", () => {
    expect(markdownToTelegramHtml("```if (a < b && c > d) {}```")).toBe(
      "<pre>if (a &lt; b &amp;&amp; c &gt; d) {}</pre>",
    );
  });

  it("handles multiple formatting spans", () => {
    expect(markdownToTelegramHtml("*bold* and _italic_")).toBe("<b>bold</b> and <i>italic</i>");
  });

  it("handles empty string", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  it("handles plain text only", () => {
    expect(markdownToTelegramHtml("no formatting here")).toBe("no formatting here");
  });
});
