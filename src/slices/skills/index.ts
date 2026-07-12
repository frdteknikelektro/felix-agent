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

/**
 * Scoped-permission matching. A permission is either bare (`skill:name`) or scoped
 * (`skill:name.<scope>`, declared by the skill as `skill:name.*`). Permission names
 * may themselves contain dots (`connection.read`), so the skill's declared list —
 * not the string shape — decides where a name ends and a scope begins. A required
 * permission is satisfied by the exact grant string, or — only when the required
 * permission is a concrete scope of a declared `skill:name.*` — by a grant of that
 * exact declared wildcard. Bare and scoped permissions of the same name never
 * satisfy each other; pseudo-wildcards (`read.staging.*`) and undeclared
 * permissions fall back to exact match only.
 */
export function permissionSatisfied(granted: string[], required: string, declared: string[]): boolean {
  if (granted.includes(required)) return true;
  if (declared.includes(required)) return false;
  // .some, not .find: with overlapping declared wildcards (read.* and read.x.*),
  // any granted covering declaration must satisfy regardless of declaration order.
  return declared.some((d) => {
    const prefix = wildcardPrefix(d);
    return prefix !== null && required.startsWith(prefix) && granted.includes(d);
  });
}

/**
 * The contact grants that count toward one declared skill permission — used to
 * render have/need. A bare declaration matches only itself; a scoped declaration
 * (`skill:name.*`) collects the wildcard itself plus concrete scopes of that name
 * (a `*`-suffixed grant other than the declared wildcard is a pseudo-wildcard the
 * matcher won't honor, so it is excluded) because which concrete scope an
 * operation needs is resolved by the LLM, not the server.
 */
export function grantsForPermission(granted: string[], declared: string): string[] {
  const prefix = wildcardPrefix(declared);
  if (prefix !== null) {
    return granted.filter(
      (grant) => grant === declared || (grant.startsWith(prefix) && !grant.endsWith("*")),
    );
  }
  return granted.includes(declared) ? [declared] : [];
}

/** Single home for the wildcard grammar: `name.*` → `name.`, anything else → null. */
export function wildcardPrefix(perm: string): string | null {
  return perm.endsWith(".*") ? perm.slice(0, -1) : null;
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
