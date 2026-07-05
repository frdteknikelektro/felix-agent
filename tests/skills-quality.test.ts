import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

describe("bundled skill quality", () => {
  it("keeps every SKILL.md lean, identified, and triggerable", async () => {
    for (const directory of await skillDirectories()) {
      const skillPath = path.join("skills", directory, "SKILL.md");
      const raw = await fs.readFile(skillPath, "utf8");
      const frontmatter = parseFrontmatter(raw);

      expect(frontmatter.name, skillPath).toBeTruthy();
      expect(frontmatter.id ?? directory, skillPath).toBe(directory);
      expect(typeof frontmatter.description, skillPath).toBe("string");
      expect((frontmatter.description as string).length, skillPath).toBeLessThanOrEqual(300);
      expect(raw.split(/\r?\n/).length, skillPath).toBeLessThanOrEqual(120);
    }
  });

  it("keeps every local markdown context pointer resolvable", async () => {
    for (const directory of await skillDirectories()) {
      for (const markdownPath of await markdownFiles(path.join("skills", directory))) {
        const raw = await fs.readFile(markdownPath, "utf8");
        const links = [...raw.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);

        for (const link of links) {
          if (/^[a-z]+:\/\//i.test(link) || link.startsWith("#")) continue;
          const target = path.resolve(path.dirname(markdownPath), link.split("#", 1)[0]);
          await expect(fs.stat(target), `${markdownPath} -> ${link}`).resolves.toBeTruthy();
        }
      }
    }
  });
});

async function skillDirectories(): Promise<string[]> {
  return (await fs.readdir("skills", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  expect(match).toBeTruthy();
  return YAML.parse(match![1]) as Record<string, unknown>;
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name !== ".agents") files.push(...await markdownFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(candidate);
  }
  return files;
}
