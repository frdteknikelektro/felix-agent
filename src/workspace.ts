import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir } from "./lib/fs.js";

export interface WorkspacePaths {
  root: string;
  intake: string;
  sessions: string;
  approvals: string;
  audit: string;
  catalog: string;
  skills: string;
  contacts: string;
  runtime: string;
  bin: string;
  tools: string;
  python: string;
  index: string;
  threadKeyIndex: string;
  botMessageIndex: string;
  projects: string;
  tasks: string;
  usage: string;
  memoryDir: string;
  wikiDir: string;
}

export function buildWorkspacePaths(root: string): WorkspacePaths {
  const intake = path.join(root, "intake");
  const catalog = path.join(root, "catalog");
  const runtime = path.join(root, "runtime");
  const index = path.join(root, "index");
  const projects = path.join(root, "projects");
  const memoryDir = path.join(root, "memory");
  return {
    root,
    intake,
    sessions: path.join(root, "sessions"),
    approvals: path.join(root, "approvals"),
    audit: path.join(root, "audit.jsonl"),
    catalog,
    skills: path.join(catalog, "skills"),
    contacts: path.join(catalog, "contacts"),
    runtime,
    bin: path.join(runtime, "bin"),
    tools: path.join(runtime, "tools"),
    python: path.join(runtime, "python"),
    index,
    threadKeyIndex: path.join(index, "thread-key"),
    botMessageIndex: path.join(index, "bot-messages"),
    projects,
    tasks: path.join(root, "tasks"),
    usage: path.join(root, "usage"),
    memoryDir,
    wikiDir: path.join(memoryDir, "wiki"),
  };
}

export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.root),
    ensureDir(paths.intake),
    ensureDir(paths.sessions),
    ensureDir(paths.approvals),
    ensureDir(paths.catalog),
    ensureDir(paths.skills),
    ensureDir(paths.contacts),
    ensureDir(paths.runtime),
    ensureDir(paths.bin),
    ensureDir(paths.tools),
    ensureDir(paths.python),
    ensureDir(paths.index),
    ensureDir(paths.threadKeyIndex),
    ensureDir(paths.botMessageIndex),
    ensureDir(paths.projects),
    ensureDir(paths.tasks),
    ensureDir(path.join(paths.tasks, "backlog")),
    ensureDir(path.join(paths.tasks, "active")),
    ensureDir(path.join(paths.tasks, "done")),
    ensureDir(path.join(paths.tasks, "cancelled")),
    ensureDir(path.join(paths.tasks, "blocked")),
    ensureDir(path.join(paths.tasks, "paused")),
    ensureDir(paths.usage),
    ensureDir(paths.memoryDir),
    ensureDir(paths.wikiDir),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "sessions")),
    ensureDir(path.join(paths.wikiDir, "comparisons")),
  ]);
}

export async function ensureMemoryDirs(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.memoryDir),
    ensureDir(paths.wikiDir),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "sessions")),
    ensureDir(path.join(paths.wikiDir, "comparisons")),
  ]);
}

export async function syncBundledSkills(
  paths: WorkspacePaths,
  options: { skip?: (name: string) => boolean } = {},
  bundledSkillsDir: string = path.resolve(process.cwd(), "skills"),
): Promise<void> {
  const entries = await fs.readdir(bundledSkillsDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;
  await ensureDir(paths.skills);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const destination = path.join(paths.skills, entry.name);
    await fs.rm(destination, { recursive: true, force: true });
    // Skipped skills are removed from the catalog too (the rm above), so
    // toggling a gated skill off (e.g. 9router when NINEROUTER_ENABLED=false)
    // leaves no stale copy that would clutter the index for users who don't
    // use it.
    if (options.skip?.(entry.name)) continue;
    const source = path.join(bundledSkillsDir, entry.name);
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
  }
}

export function sourceSessionsDir(paths: WorkspacePaths, source: string): string {
  return path.join(paths.sessions, source);
}

export function sourceContactsDir(paths: WorkspacePaths, source: string): string {
  return path.join(paths.contacts, source);
}

export function sourceRawDir(paths: WorkspacePaths, source: string): string {
  return path.join(paths.intake, source, "raw");
}

export function sourceThreadKeyIndexDir(paths: WorkspacePaths, source: string): string {
  return path.join(paths.threadKeyIndex, source);
}

export function projectProviderDir(paths: WorkspacePaths, provider: string): string {
  return path.join(paths.projects, provider);
}

export function projectNamespaceDir(paths: WorkspacePaths, provider: string, namespace: string): string {
  return path.join(projectProviderDir(paths, provider), namespace);
}

export function projectRepoDir(paths: WorkspacePaths, provider: string, namespace: string, repo: string): string {
  return path.join(projectNamespaceDir(paths, provider, namespace), repo);
}
