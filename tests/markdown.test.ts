import { describe, expect, it } from "vitest";
import { parseFrontmatter, renderFrontmatter } from "../src/lib/markdown.js";

describe("markdown frontmatter", () => {
  it("round-trips frontmatter and body", () => {
    const input = renderFrontmatter(
      { type: "demo", count: 2, tags: ["a", "b"] },
      "\nhello world\n",
    );
    const parsed = parseFrontmatter<{ type?: string; count?: number; tags?: string[] }>(input);
    expect(parsed.frontmatter.type).toBe("demo");
    expect(parsed.frontmatter.count).toBe(2);
    expect(parsed.frontmatter.tags).toEqual(["a", "b"]);
    expect(parsed.body.trim()).toBe("hello world");
  });
});
