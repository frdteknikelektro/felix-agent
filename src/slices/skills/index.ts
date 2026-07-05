import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readText, writeTextAtomic } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import type { SkillRecord } from "../../types.js";

interface SkillFrontmatter {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  permissions?: string[];
}

export async function loadSkills(cfg: AppConfig): Promise<SkillRecord[]> {
  await ensureDir(cfg.paths.skills);
  const entries = await fs.readdir(cfg.paths.skills, { withFileTypes: true });
  const out: SkillRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(cfg.paths.skills, entry.name, "SKILL.md");
    if (!(await pathExists(skillPath))) continue;
    const raw = await readText(skillPath);
    const { frontmatter, body } = parseSkill(raw);
    if (frontmatter.enabled === false) continue;
    const id = frontmatter.id ?? entry.name;
    out.push({
      id,
      name: frontmatter.name,
      description: frontmatter.description,
      permissions: normalizePermissions(frontmatter.permissions).map((p) => `${id}:${p}`),
      path: skillPath,
      body,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function writeSkillIndex(cfg: AppConfig, skills: SkillRecord[]): Promise<void> {
  const lines = [
    "# Skill Index",
    "",
    ...skills.map((skill) => {
      const perms = skill.permissions.length > 0 ? skill.permissions.join(", ") : "(none)";
      const description = skill.description?.trim() || "(no description)";
      return `- ${skill.id} | ${skill.name ?? skill.id} | ${description} | permissions: ${perms} | ${skill.path}`;
    }),
    "",
  ];
  await writeTextAtomic(path.join(cfg.paths.skills, "index.md"), lines.join("\n"));
}

export function skillPaths(skills: SkillRecord[]): string[] {
  return skills.map((skill) => skill.path);
}

export function skillMatchesPermission(skill: SkillRecord, permissions: string[]): boolean {
  return skill.permissions.every((permission) => permissions.includes(permission));
}

function parseSkill(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: raw };
  try {
    const yaml = raw.slice(4, end);
    return {
      frontmatter: (YAML.parse(yaml) ?? {}) as SkillFrontmatter,
      body: raw.slice(end + 5),
    };
  } catch (error) {
    log.warn("skills.yaml_parse_failed", { error: error instanceof Error ? error.message : String(error) });
    return { frontmatter: {}, body: raw };
  }
}

function normalizePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}
