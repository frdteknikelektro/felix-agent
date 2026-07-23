import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, pathExists, writeTextAtomic } from "./lib/fs.js";

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
  localProjects: string;
  fileCollections: string;
  tasks: string;
  usage: string;
  memoryDir: string;
  memoryFile: string;
  memoryDailyDir: string;
  memoryWeeklyDir: string;
  memoryMonthlyDir: string;
  schedulerJobsDir: string;
  schedulerLogsDir: string;
}

export function buildWorkspacePaths(root: string): WorkspacePaths {
  const intake = path.join(root, "intake");
  const catalog = path.join(root, "catalog");
  const runtime = path.join(root, "runtime");
  const index = path.join(root, "index");
  const projects = path.join(root, "projects");
  const fileCollections = path.join(root, "files");
  const memoryDir = path.join(root, "memory");
  const schedulerDir = path.join(root, "scheduler");
  return {
    root,
    intake,
    sessions: path.join(root, "sessions"),
    approvals: path.join(root, "approvals"),
    audit: path.join(root, "audit.jsonl"),
    catalog,
    skills: path.join(root, ".agents", "skills"),
    contacts: path.join(catalog, "contacts"),
    runtime,
    bin: path.join(runtime, "bin"),
    tools: path.join(runtime, "tools"),
    python: path.join(runtime, "python"),
    index,
    threadKeyIndex: path.join(index, "thread-key"),
    botMessageIndex: path.join(index, "bot-messages"),
    projects,
    localProjects: path.join(projects, "local"),
    fileCollections,
    tasks: path.join(root, "tasks"),
    usage: path.join(root, "usage"),
    memoryDir,
    memoryFile: path.join(root, "MEMORY.md"),
    memoryDailyDir: path.join(memoryDir, "daily"),
    memoryWeeklyDir: path.join(memoryDir, "weekly"),
    memoryMonthlyDir: path.join(memoryDir, "monthly"),
    schedulerJobsDir: path.join(schedulerDir, "jobs"),
    schedulerLogsDir: path.join(schedulerDir, "logs"),
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
    ensureDir(paths.localProjects),
    ensureDir(paths.fileCollections),
    ensureDir(paths.tasks),
    ensureDir(path.join(paths.tasks, "backlog")),
    ensureDir(path.join(paths.tasks, "active")),
    ensureDir(path.join(paths.tasks, "done")),
    ensureDir(path.join(paths.tasks, "cancelled")),
    ensureDir(path.join(paths.tasks, "blocked")),
    ensureDir(path.join(paths.tasks, "paused")),
    ensureDir(paths.usage),
    ensureDir(paths.memoryDir),
    ensureDir(paths.memoryDailyDir),
    ensureDir(paths.memoryWeeklyDir),
    ensureDir(paths.memoryMonthlyDir),
    ensureDir(paths.schedulerJobsDir),
    ensureDir(paths.schedulerLogsDir),
  ]);
  await ensureMemoryFile(paths);
}

export async function ensureMemoryDirs(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.memoryDir),
    ensureDir(paths.memoryDailyDir),
    ensureDir(paths.memoryWeeklyDir),
    ensureDir(paths.memoryMonthlyDir),
  ]);
  await ensureMemoryFile(paths);
}

async function ensureMemoryFile(paths: WorkspacePaths): Promise<void> {
  if (await pathExists(paths.memoryFile)) return;
  await writeTextAtomic(paths.memoryFile, "# Memory\n");
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

/** Convert a human-facing name into one safe, readable workspace path segment. */
export function workspaceSlug(value: string): string {
  if (/[\\/]/u.test(value)) {
    throw new Error("Workspace name must not contain a path separator");
  }
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error("Workspace name must not contain control characters");
  }
  const slug = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || slug === "." || slug === "..") {
    throw new Error("Workspace name must contain a usable letter or number");
  }
  return slug;
}

export function localProjectDir(paths: WorkspacePaths, project: string): string {
  return path.join(paths.localProjects, workspaceSlug(project));
}

export function fileCollectionDir(paths: WorkspacePaths, collection: string): string {
  return path.join(paths.fileCollections, workspaceSlug(collection));
}

/**
 * Validate a prospective user-work target against both the canonical category
 * roots and the real workspace path. The target may not exist yet.
 */
export async function assertWorkspaceTarget(
  paths: WorkspacePaths,
  target: string,
  options: { threadDir?: string } = {},
): Promise<string> {
  const absoluteTarget = path.isAbsolute(target) ? path.resolve(target) : path.resolve(paths.root, target);
  const canonicalRoots = [
    paths.fileCollections,
    paths.localProjects,
    projectProviderDir(paths, "github"),
    projectProviderDir(paths, "gitlab"),
    ...(options.threadDir
      ? [path.join(options.threadDir, "work"), path.join(options.threadDir, "attachments")]
      : []),
  ];
  if (!canonicalRoots.some((root) => isWithin(root, absoluteTarget))) {
    throw new Error(`Target is not inside a canonical user-work area: ${target}`);
  }

  const realRoot = await fs.realpath(paths.root);
  await assertExistingSymlinksStayWithin(paths.root, absoluteTarget, realRoot);
  let ancestor = absoluteTarget;
  let realAncestor: string;

  while (true) {
    try {
      realAncestor = await fs.realpath(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }

  const resolvedTarget = path.resolve(realAncestor, path.relative(ancestor, absoluteTarget));
  const relative = path.relative(realRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Target resolves outside the workspace: ${target}`);
  }
  return absoluteTarget;
}

async function assertExistingSymlinksStayWithin(root: string, target: string, realRoot: string): Promise<void> {
  const relative = path.relative(path.resolve(root), target);
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isSymbolicLink()) continue;
    const resolved = await fs.realpath(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(`Cannot validate dangling symbolic link inside the workspace: ${current}`);
      }
      throw error;
    });
    if (!isWithin(realRoot, resolved)) {
      throw new Error(`Target resolves outside the workspace through a symbolic link: ${current}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
