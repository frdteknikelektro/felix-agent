import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir } from "./lib/fs.js";

export interface WorkspacePaths {
  root: string;
  intake: string;
  records: string;
  sessions: string;
  approvals: string;
  audit: string;
  catalog: string;
  skills: string;
  contacts: string;
  runtime: string;
  health: string;
  bin: string;
  tools: string;
  python: string;
  index: string;
  threadKeyIndex: string;
  projects: string;
  tasks: string;
  memoryDir: string;
  wikiDir: string;
}

export function buildWorkspacePaths(root: string): WorkspacePaths {
  const intake = path.join(root, "intake");
  const records = path.join(root, "records");
  const catalog = path.join(root, "catalog");
  const runtime = path.join(root, "runtime");
  const index = path.join(root, "index");
  const projects = path.join(root, "projects");
  const memoryDir = path.join(root, "memory");
  return {
    root,
    intake,
    records,
    sessions: path.join(records, "sessions"),
    approvals: path.join(records, "approvals"),
    audit: path.join(records, "audit.jsonl"),
    catalog,
    skills: path.join(catalog, "skills"),
    contacts: path.join(catalog, "contacts"),
    runtime,
    health: path.join(runtime, "health"),
    bin: path.join(runtime, "bin"),
    tools: path.join(runtime, "tools"),
    python: path.join(runtime, "python"),
    index,
    threadKeyIndex: path.join(index, "thread-key"),
    projects,
    tasks: path.join(root, "tasks"),
    memoryDir,
    wikiDir: path.join(memoryDir, "wiki"),
  };
}

export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.root),
    ensureDir(paths.intake),
    ensureDir(paths.records),
    ensureDir(paths.sessions),
    ensureDir(paths.approvals),
    ensureDir(paths.catalog),
    ensureDir(paths.skills),
    ensureDir(paths.contacts),
    ensureDir(paths.runtime),
    ensureDir(paths.health),
    ensureDir(paths.bin),
    ensureDir(paths.tools),
    ensureDir(paths.python),
    ensureDir(paths.index),
    ensureDir(paths.threadKeyIndex),
    ensureDir(paths.projects),
    ensureDir(paths.tasks),
    ensureDir(path.join(paths.tasks, "backlog")),
    ensureDir(path.join(paths.tasks, "active")),
    ensureDir(path.join(paths.tasks, "done")),
    ensureDir(path.join(paths.tasks, "cancelled")),
    ensureDir(path.join(paths.tasks, "blocked")),
    ensureDir(path.join(paths.tasks, "paused")),
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
  bundledSkillsDir: string = path.resolve(process.cwd(), "skills"),
): Promise<void> {
  const entries = await fs.readdir(bundledSkillsDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;
  await ensureDir(paths.skills);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "memory") continue;
    const source = path.join(bundledSkillsDir, entry.name);
    const destination = path.join(paths.skills, entry.name);
    await fs.rm(destination, { recursive: true, force: true });
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
