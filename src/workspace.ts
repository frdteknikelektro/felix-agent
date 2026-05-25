import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, pathExists } from "./lib/fs.js";

export interface WorkspacePaths {
  root: string;
  raw: string;
  threads: string;
  contacts: string;
  skills: string;
  logs: string;
  media: string;
  codex: string;
  health: string;
}

export function buildWorkspacePaths(root: string): WorkspacePaths {
  return {
    root,
    raw: path.join(root, "raw"),
    threads: path.join(root, "threads"),
    contacts: path.join(root, "contacts"),
    skills: path.join(root, "skills"),
    logs: path.join(root, "logs"),
    media: path.join(root, "media"),
    codex: path.join(root, "codex"),
    health: path.join(root, ".health"),
  };
}

export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.root),
    ensureDir(paths.raw),
    ensureDir(paths.threads),
    ensureDir(paths.contacts),
    ensureDir(paths.skills),
    ensureDir(paths.logs),
    ensureDir(paths.media),
    ensureDir(paths.codex),
  ]);
}

export async function syncBundledSkills(
  paths: WorkspacePaths,
  bundledSkillsDir: string = path.resolve(process.cwd(), "skills"),
): Promise<void> {
  const entries = await fs.readdir(bundledSkillsDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;
  await ensureDir(paths.skills);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(bundledSkillsDir, entry.name);
    const destination = path.join(paths.skills, entry.name);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
  }
}

export function sourceDir(paths: WorkspacePaths, source: string): string {
  return path.join(paths.threads, source);
}

export function sourceContactsDir(paths: WorkspacePaths, source: string): string {
  return path.join(paths.contacts, source);
}

export function sourceRawDir(paths: WorkspacePaths, source: string): string {
  return path.join(paths.raw, source);
}
