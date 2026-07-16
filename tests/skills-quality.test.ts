import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { loadSkills, permissionSatisfied } from "../src/slices/skills/index.js";
import { buildWorkspacePaths, syncBundledSkills } from "../src/workspace.js";

describe("bundled skill quality", () => {
  it("declares Google Workspace setup variables for the setup wizard", async () => {
    const raw = await fs.readFile(path.join("skills", "google-workspace", "SKILL.md"), "utf8");
    const frontmatter = parseFrontmatter(raw);
    const env = frontmatter.env as Array<{ key: string; secret?: boolean }> | undefined;

    expect(env?.map((entry) => entry.key)).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOG_HOME",
      "GOG_KEYRING_BACKEND",
      "GOG_KEYRING_PASSWORD",
    ]);
    expect(env?.filter((entry) => entry.secret).map((entry) => entry.key)).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOG_KEYRING_PASSWORD",
    ]);
  });

  it("keeps every SKILL.md lean, identified, and triggerable", async () => {
    for (const directory of await skillDirectories()) {
      const skillPath = path.join("skills", directory, "SKILL.md");
      const raw = await fs.readFile(skillPath, "utf8");
      const frontmatter = parseFrontmatter(raw);

      expect(frontmatter.name, skillPath).toBeTruthy();
      expect(frontmatter.id ?? directory, skillPath).toBe(directory);
      expect(typeof frontmatter.description, skillPath).toBe("string");
      expect((frontmatter.description as string).length, skillPath).toBeLessThanOrEqual(300);
      expect(frontmatter.description, skillPath).not.toMatch(/replace with|placeholder/i);
      expect(raw.split(/\r?\n/).length, skillPath).toBeLessThanOrEqual(120);
      const metadata = frontmatter.metadata as Record<string, unknown>;
      expect(metadata.author, skillPath).toBe("felix-agent");
      expect(["general", "operational"], skillPath).toContain(metadata.kind);
      expect(metadata.version, skillPath).toMatch(/^\d+\.\d+\.\d+$/);
      expect(metadata.match, skillPath).toBeTruthy();
      expect(metadata.match, skillPath).not.toMatch(/replace with|placeholder/i);

      const permissions = String(metadata.permissions ?? "")
        .split(",")
        .map((permission) => permission.trim())
        .filter(Boolean);
      expect(new Set(permissions).size, skillPath).toBe(permissions.length);
      if (permissions.length === 0) {
        expect(raw, skillPath).toContain("No permissions required");
      } else {
        for (const permission of permissions) {
          expect(permission, skillPath).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z0-9*-]+)*$/);
          const documented = permission.replace(/\.\*$/, "");
          const forms = [
            permission,
            documented,
            `${directory}:${permission}`,
            `${directory}:${documented}`,
          ];
          expect(
            forms.some((form) => raw.includes(`\`${form}\``)),
            `${skillPath}: ${permission}`,
          ).toBe(true);
        }
      }

      for (const entry of (frontmatter.env ?? []) as Array<Record<string, unknown>>) {
        expect(entry.key, skillPath).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(entry.description, skillPath).toBeTruthy();
        expect(raw, `${skillPath}: prerequisite ${String(entry.key)}`).toContain(String(entry.key));
        if (entry.secret !== undefined) expect(typeof entry.secret, skillPath).toBe("boolean");
        if (entry.secret === true) expect(entry.default, skillPath).toBeUndefined();
      }
    }
  });

  it("syncs and loads every dynamically discovered bundled skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-bundled-skill-gate-"));
    const paths = buildWorkspacePaths(path.join(root, "workspace"));
    const expected = await skillDirectories();

    await syncBundledSkills(paths);
    const loaded = await loadSkills({ WORKSPACE_DIR: paths.root, paths } as never);

    expect(loaded.map((skill) => skill.id)).toEqual(expected);
    for (const skill of loaded) {
      expect(skill.name, skill.id).toBeTruthy();
      expect(skill.description, skill.id).toBeTruthy();
      expect(skill.body.trim().length, skill.id).toBeGreaterThan(0);
    }
  });

  it("exercises every dynamically loaded skill's permission boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-bundled-skill-permissions-"));
    const paths = buildWorkspacePaths(path.join(root, "workspace"));

    try {
      await syncBundledSkills(paths);
      const loaded = await loadSkills({ WORKSPACE_DIR: paths.root, paths } as never);
      for (const skill of loaded) {
        for (const permission of skill.permissions) {
          expect(permissionSatisfied([], permission, skill.permissions), permission).toBe(false);
          expect(permissionSatisfied([permission], permission, skill.permissions), permission).toBe(true);
          expect(
            permissionSatisfied([`another-skill:${permission}`], permission, skill.permissions),
            permission,
          ).toBe(false);

          if (permission.endsWith(".*")) {
            const concrete = `${permission.slice(0, -1)}smoke`;
            expect(permissionSatisfied([], concrete, skill.permissions), concrete).toBe(false);
            expect(permissionSatisfied([permission], concrete, skill.permissions), concrete).toBe(true);
          }
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("syntax-checks every bundled skill helper as a smoke gate", async () => {
    for (const helper of await helperFiles("skills")) {
      if (helper.endsWith(".mjs")) {
        execFileSync(process.execPath, ["--check", helper], { stdio: "pipe" });
      } else if (helper.endsWith(".py")) {
        execFileSync("python3", [
          "-c",
          "import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], 'exec')",
          helper,
        ], { stdio: "pipe" });
      } else if (helper.endsWith(".sh")) {
        execFileSync("bash", ["-n", helper], { stdio: "pipe" });
      }
    }
  }, 15_000);

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

async function helperFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await helperFiles(candidate));
    else if (entry.isFile() && /\.(?:mjs|py|sh)$/.test(entry.name)) files.push(candidate);
  }
  return files.sort();
}
