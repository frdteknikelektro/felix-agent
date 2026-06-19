import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../config.js";

function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function queryMemory(cfg: AppConfig, eventText: string): string | null {
  const wikiDir = cfg.paths.wikiDir;
  const indexPath = path.join(wikiDir, "index.md");
  const index = readIfExists(indexPath);
  if (!index) return null;

  const lines = index.split("\n").filter((l) => l.startsWith("- ["));
  if (lines.length === 0) return null;

  const eventWords = new Set(
    eventText
      .toLowerCase()
      .split(/[^a-zA-Z0-9]+/)
      .filter((w) => w.length > 2),
  );

  const scored = lines
    .map((line) => {
      const lineLower = line.toLowerCase();
      const hits = [...eventWords].filter((w) => lineLower.includes(w)).length;
      return { line, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3);

  if (scored.length === 0) return null;

  return scored
    .map((s) => {
      const match = s.line.match(/\[\[(.+?)\]\]/);
      if (!match) return null;
      const pagePath = match[1];
      const fullPath = path.join(wikiDir, `${pagePath}.md`);
      const content = readIfExists(fullPath);
      if (!content) return null;

      const titleMatch = content.match(/^title:\s*"(.+)"/m);
      const title = titleMatch?.[1] ?? pagePath;
      const frontmatterEnd = content.indexOf("---", 4);
      const body = frontmatterEnd > 0 ? content.slice(frontmatterEnd + 3).trim() : content;
      const paragraphs = body.split("\n\n").filter((p) => !p.startsWith("#"));
      const summary = (paragraphs[0] ?? body).slice(0, 400);

      return `### ${title}\n${summary}`;
    })
    .filter(Boolean)
    .join("\n\n") || null;
}
