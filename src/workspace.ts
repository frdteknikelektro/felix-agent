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

export type HostedProjectProvider = "github" | "gitlab";

export type WorkspaceTarget =
  | { kind: "file_collection"; collection: string; relative?: string }
  | { kind: "local_project"; project: string; relative?: string }
  | {
      kind: "hosted_project";
      provider: HostedProjectProvider;
      namespace: string[];
      repo: string;
      relative?: string;
    }
  | { kind: "session_work"; threadDir: string; workName: string; relative?: string }
  | { kind: "session_attachment"; threadDir: string; filename: string };

/**
 * Build and validate a complete canonical destination. Callers select a
 * category rather than supplying an arbitrary path, so incomplete roots such
 * as `files/report.pdf` or `projects/github/acme` cannot pass validation.
 */
export async function resolveWorkspaceTarget(paths: WorkspacePaths, target: WorkspaceTarget): Promise<string> {
  let categoryRoot: string;
  let absoluteTarget: string;
  let categoryLabel: string;

  switch (target.kind) {
    case "file_collection": {
      categoryRoot = paths.fileCollections;
      categoryLabel = "File Collection";
      absoluteTarget = appendRelative(fileCollectionDir(paths, target.collection), target.relative, true);
      break;
    }
    case "local_project": {
      categoryRoot = paths.localProjects;
      categoryLabel = "Local Project";
      absoluteTarget = appendRelative(localProjectDir(paths, target.project), target.relative);
      break;
    }
    case "hosted_project": {
      if (target.provider !== "github" && target.provider !== "gitlab") {
        throw new Error(`Unsupported Hosted Project provider: ${String(target.provider)}`);
      }
      if (target.namespace.length === 0) {
        throw new Error("Hosted Project namespace must contain at least one segment");
      }
      const namespace = target.namespace.map(workspaceSlug);
      const providerRoot = projectProviderDir(paths, target.provider);
      const projectRoot = path.join(providerRoot, ...namespace, workspaceSlug(target.repo));
      categoryRoot = providerRoot;
      categoryLabel = "Hosted Project";
      absoluteTarget = appendRelative(projectRoot, target.relative);
      break;
    }
    case "session_work": {
      await assertSessionDir(paths, target.threadDir);
      categoryRoot = path.join(path.resolve(target.threadDir), "work");
      categoryLabel = "Session work";
      absoluteTarget = appendRelative(path.join(categoryRoot, workspaceSlug(target.workName)), target.relative, true);
      break;
    }
    case "session_attachment": {
      await assertSessionDir(paths, target.threadDir);
      categoryRoot = path.join(path.resolve(target.threadDir), "attachments");
      categoryLabel = "Session attachments";
      absoluteTarget = path.join(categoryRoot, canonicalFileName(target.filename, "Attachment filename"));
      break;
    }
  }

  await assertResolvedWithinCategory(paths.root, categoryRoot, absoluteTarget, categoryLabel);
  return absoluteTarget;
}

function appendRelative(root: string, relative?: string, canonicalNames = false): string {
  if (relative === undefined || relative === "") return root;
  if (path.isAbsolute(relative) || relative.includes("\\")) {
    throw new Error("Relative path must use non-absolute forward-slash segments");
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Relative path must not contain empty, current-directory, or parent-directory segments");
  }
  return path.join(
    root,
    ...segments.map((segment, index) =>
      canonicalNames
        ? canonicalDescendantSegment(segment, index === segments.length - 1)
        : safePathSegment(segment, "Relative path"),
    ),
  );
}

function safePathSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/u.test(value)) {
    throw new Error(`${label} must be one non-empty path segment`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return value;
}

function canonicalDescendantSegment(value: string, finalSegment: boolean): string {
  const safe = safePathSegment(value.normalize("NFKC").trim(), "Relative path");
  return finalSegment ? canonicalFileName(safe, "Relative path") : workspaceSlug(safe);
}

function canonicalFileName(value: string, label: string): string {
  const safe = safePathSegment(value.normalize("NFKC").trim(), label);
  const extensionMatch = safe.match(/((?:\.[\p{L}\p{N}]+)+)$/u);
  if (!extensionMatch || extensionMatch.index === 0) return workspaceSlug(safe);
  const stem = safe.slice(0, extensionMatch.index);
  const extensions = extensionMatch[1]!
    .split(".")
    .filter(Boolean)
    .map(workspaceSlug)
    .join(".");
  return `${workspaceSlug(stem)}.${extensions}`;
}

async function assertSessionDir(paths: WorkspacePaths, threadDir: string): Promise<void> {
  const absoluteThreadDir = path.resolve(threadDir);
  if (!isWithin(paths.sessions, absoluteThreadDir)) {
    throw new Error(`Session directory is outside the Workspace sessions area: ${threadDir}`);
  }
  const sessionSegments = path.relative(path.resolve(paths.sessions), absoluteThreadDir).split(path.sep).filter(Boolean);
  if (sessionSegments.length !== 2) {
    throw new Error(`Session directory must identify exactly one source and session id: ${threadDir}`);
  }
  const stat = await fs.stat(absoluteThreadDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.isDirectory()) {
    throw new Error(`Session directory does not exist: ${threadDir}`);
  }
  await assertResolvedWithinCategory(paths.root, paths.sessions, absoluteThreadDir, "Session");
}

async function assertResolvedWithinCategory(
  workspaceRoot: string,
  root: string,
  target: string,
  label: string,
): Promise<void> {
  if (!isWithin(root, target)) {
    throw new Error(`Target is outside its canonical ${label} area: ${target}`);
  }
  const realWorkspace = await fs.realpath(workspaceRoot);
  const expectedRealRoot = path.resolve(realWorkspace, path.relative(path.resolve(workspaceRoot), path.resolve(root)));
  const { ancestor: rootAncestor, realAncestor: realRootAncestor } = await nearestRealAncestor(root);
  const realRoot = path.resolve(realRootAncestor, path.relative(rootAncestor, root));
  if (realRoot !== expectedRealRoot) {
    throw new Error(`Canonical ${label} area is redirected through a symbolic link: ${root}`);
  }
  await assertExistingSymlinksStayWithin(root, target, realRoot, label);
  const { ancestor, realAncestor } = await nearestRealAncestor(target);
  const resolvedTarget = path.resolve(realAncestor, path.relative(ancestor, target));
  if (!isWithin(realRoot, resolvedTarget)) {
    throw new Error(`Target resolves outside its canonical ${label} area: ${target}`);
  }
}

async function nearestRealAncestor(target: string): Promise<{ ancestor: string; realAncestor: string }> {
  let ancestor = target;
  while (true) {
    try {
      return { ancestor, realAncestor: await fs.realpath(ancestor) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function assertExistingSymlinksStayWithin(
  root: string,
  target: string,
  realRoot: string,
  label: string,
): Promise<void> {
  const relative = path.relative(path.resolve(root), target);
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(`Cannot validate a hard link used as a user-work target: ${current}`);
    }
    if (!stat.isSymbolicLink()) continue;
    const resolved = await fs.realpath(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(`Cannot validate dangling symbolic link inside the workspace: ${current}`);
      }
      throw error;
    });
    const resolvedStat = await fs.stat(resolved);
    if (resolvedStat.isFile() && resolvedStat.nlink > 1) {
      throw new Error(`Cannot validate a symbolic link to a hard link used as a user-work target: ${current}`);
    }
    if (!isWithin(realRoot, resolved)) {
      throw new Error(`Target resolves outside its canonical ${label} area through a symbolic link: ${current}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
