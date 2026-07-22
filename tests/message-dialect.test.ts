import { describe, expect, it } from "vitest";
import { toDialect } from "../src/core/message-dialect.js";

// Table-driven: one CommonMark input, the expected render in each marker-text
// / HTML dialect. Discord is the identity and is checked separately below.
const CASES: Array<{
  name: string;
  input: string;
  slack: string;
  whatsapp: string;
  telegram: string;
}> = [
  {
    name: "bold (** and __)",
    input: "**bold** and __also bold__",
    slack: "*bold* and *also bold*",
    whatsapp: "*bold* and *also bold*",
    telegram: "<b>bold</b> and <b>also bold</b>",
  },
  {
    name: "italic (* and _)",
    input: "*italic* and _also italic_",
    slack: "_italic_ and _also italic_",
    whatsapp: "_italic_ and _also italic_",
    telegram: "<i>italic</i> and <i>also italic</i>",
  },
  {
    name: "strikethrough",
    input: "~~gone~~",
    slack: "~gone~",
    whatsapp: "~gone~",
    telegram: "<s>gone</s>",
  },
  {
    name: "nested bold + italic",
    input: "**bold _inner_**",
    slack: "*bold _inner_*",
    whatsapp: "*bold _inner_*",
    telegram: "<b>bold <i>inner</i></b>",
  },
  {
    name: "headers → bold line",
    input: "# Title\n## Subtitle",
    slack: "*Title*\n*Subtitle*",
    whatsapp: "*Title*\n*Subtitle*",
    telegram: "<b>Title</b>\n<b>Subtitle</b>",
  },
  {
    name: "bullet lists → literal bullet",
    input: "- one\n- two\n* three",
    slack: "• one\n• two\n• three",
    whatsapp: "• one\n• two\n• three",
    telegram: "• one\n• two\n• three",
  },
  {
    name: "inline code left intact",
    input: "`**not bold**`",
    slack: "`**not bold**`",
    whatsapp: "`**not bold**`",
    telegram: "<code>**not bold**</code>",
  },
  {
    name: "links",
    input: "[Felix](https://example.com)",
    slack: "<https://example.com|Felix>",
    whatsapp: "Felix (https://example.com)",
    telegram: '<a href="https://example.com">Felix</a>',
  },
];

describe("toDialect", () => {
  for (const c of CASES) {
    it(`${c.name} → slack`, () => expect(toDialect(c.input, "slack")).toBe(c.slack));
    it(`${c.name} → whatsapp`, () => expect(toDialect(c.input, "whatsapp")).toBe(c.whatsapp));
    it(`${c.name} → telegram-html`, () => expect(toDialect(c.input, "telegram-html")).toBe(c.telegram));
  }

  it("does not italicize underscores inside a word (snake_case)", () => {
    expect(toDialect("call foo_bar_baz now", "slack")).toBe("call foo_bar_baz now");
    expect(toDialect("call foo_bar_baz now", "whatsapp")).toBe("call foo_bar_baz now");
  });

  it("leaves an unmatched emphasis marker literal", () => {
    expect(toDialect("*unmatched", "slack")).toBe("*unmatched");
    expect(toDialect("*unmatched", "telegram-html")).toBe("*unmatched");
  });

  it("collapses a WhatsApp link whose label equals the url to a bare url", () => {
    expect(toDialect("[https://x.com](https://x.com)", "whatsapp")).toBe("https://x.com");
  });

  it("escapes HTML-significant characters for Telegram", () => {
    expect(toDialect("a < b & c > d", "telegram-html")).toBe("a &lt; b &amp; c &gt; d");
  });

  describe("fenced code blocks", () => {
    const block = "```\n- not a bullet\n**not bold**\n```";
    it("passes through verbatim for marker-text dialects", () => {
      expect(toDialect(block, "slack")).toBe(block);
      expect(toDialect(block, "whatsapp")).toBe(block);
    });
    it("renders as <pre> for Telegram, escaping the body", () => {
      expect(toDialect("```\ncode < 1\n```", "telegram-html")).toBe("<pre>code &lt; 1</pre>");
    });
  });

  describe("Discord is the identity", () => {
    it("returns CommonMark untouched (Discord renders it natively)", () => {
      const md = "# Title\n\n**bold**, *italic*, `code`, [x](https://y.com)\n- a\n- b";
      expect(toDialect(md, "discord")).toBe(md);
    });
  });

  describe("regression: harness CommonMark that used to render literally", () => {
    it("Slack skills list", () => {
      const input = [
        "Here are the skills I currently have installed:",
        "",
        "- **General** — Conversational fallback for questions, explanations, and summaries",
        "- **Memory** — Persistent knowledge wiki across conversations",
        "",
        "Is there something specific you'd like help with?",
      ].join("\n");
      const output = [
        "Here are the skills I currently have installed:",
        "",
        "• *General* — Conversational fallback for questions, explanations, and summaries",
        "• *Memory* — Persistent knowledge wiki across conversations",
        "",
        "Is there something specific you'd like help with?",
      ].join("\n");
      expect(toDialect(input, "slack")).toBe(output);
    });

    it("WhatsApp bold no longer leaks as literal **asterisks**", () => {
      expect(toDialect("**important**", "whatsapp")).toBe("*important*");
    });
  });
});
