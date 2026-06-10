import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readJsonParsed, safeFileName, writeJsonAtomic } from "../../lib/fs.js";
import { TaskRecordSchema } from "../../core/schemas.js";
import type { TaskRecord, TaskStatus } from "../../types.js";

const STATUS_DIRS: readonly TaskStatus[] = [
  "backlog",
  "active",
  "done",
  "cancelled",
  "blocked",
  "paused",
];

// ─── ID generation ───────────────────────────────────────────────────────────

export function generateTaskId(title: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${ts}-${slug}`;
}

async function resolveTaskId(cfg: AppConfig, baseId: string): Promise<string> {
  let id = baseId;
  let n = 2;
  while ((await findTaskPath(cfg, id)) !== null) {
    id = `${baseId}-${n}`;
    n++;
  }
  return id;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function taskFilePath(tasksDir: string, status: TaskStatus, taskId: string): string {
  return path.join(tasksDir, status, `${safeFileName(taskId)}.json`);
}

async function findTaskPath(cfg: AppConfig, taskId: string): Promise<string | null> {
  for (const status of STATUS_DIRS) {
    const file = taskFilePath(cfg.paths.tasks, status, taskId);
    if (await pathExists(file)) return file;
  }
  return null;
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  description: string;
  created_by: { source: string; user_id: string };
  parent_source: string;
  parent_thread_key: string;
  parent_post_id?: string;
}

export async function createTask(cfg: AppConfig, input: CreateTaskInput): Promise<TaskRecord> {
  const baseId = generateTaskId(input.title);
  const id = await resolveTaskId(cfg, baseId);
  const now = new Date().toISOString();
  const record: TaskRecord = {
    schema_version: 1,
    id,
    status: "backlog",
    title: input.title,
    description: input.description,
    created_at: now,
    created_by: input.created_by,
    parent_source: input.parent_source,
    parent_thread_key: input.parent_thread_key,
    parent_post_id: input.parent_post_id,
    started_at: null,
    completed_at: null,
    updated_at: now,
  };
  await ensureDir(path.join(cfg.paths.tasks, "backlog"));
  const file = taskFilePath(cfg.paths.tasks, "backlog", id);
  await writeJsonAtomic(file, record);
  return record;
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function readTask(cfg: AppConfig, taskId: string): Promise<TaskRecord | null> {
  const file = await findTaskPath(cfg, taskId);
  if (!file) return null;
  return readJsonParsed(file, TaskRecordSchema, null as unknown as TaskRecord);
}

// ─── Move / status transition ────────────────────────────────────────────────

export async function moveTask(
  cfg: AppConfig,
  taskId: string,
  newStatus: TaskStatus,
  patches?: Partial<Pick<TaskRecord, "started_at" | "completed_at">>,
): Promise<TaskRecord | null> {
  const currentPath = await findTaskPath(cfg, taskId);
  if (!currentPath) return null;

  const destDir = path.join(cfg.paths.tasks, newStatus);
  await ensureDir(destDir);
  const destPath = taskFilePath(cfg.paths.tasks, newStatus, taskId);

  const record = await readJsonParsed(currentPath, TaskRecordSchema, null as unknown as TaskRecord);
  if (!record) return null;

  await fs.rename(currentPath, destPath);

  const now = new Date().toISOString();
  const autoPatches: Partial<Pick<TaskRecord, "started_at" | "completed_at">> = {};
  if (newStatus === "active" && record.started_at === null) {
    autoPatches.started_at = now;
  }
  if (newStatus === "done" && record.completed_at === null) {
    autoPatches.completed_at = now;
  }
  if (newStatus === "backlog") {
    autoPatches.started_at = null;
    autoPatches.completed_at = null;
  }

  const updated: TaskRecord = {
    ...record,
    status: newStatus,
    updated_at: now,
    ...autoPatches,
    ...(patches?.started_at !== undefined ? { started_at: patches.started_at } : {}),
    ...(patches?.completed_at !== undefined ? { completed_at: patches.completed_at } : {}),
  };
  await writeJsonAtomic(destPath, updated);
  return updated;
}

// ─── List ────────────────────────────────────────────────────────────────────

export interface ListTasksOpts {
  status?: TaskStatus;
}

export async function listTasks(cfg: AppConfig, opts?: ListTasksOpts): Promise<TaskRecord[]> {
  const dirs = opts?.status ? [opts.status] : [...STATUS_DIRS];
  const out: TaskRecord[] = [];
  for (const status of dirs) {
    const dir = path.join(cfg.paths.tasks, status);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(dir, entry.name);
      const record = await readJsonParsed(file, TaskRecordSchema, null as unknown as TaskRecord);
      if (record) out.push(record);
    }
  }
  out.sort((a, b) => b.id.localeCompare(a.id));
  return out;
}

// ─── Resolve path ────────────────────────────────────────────────────────────

export async function resolveTaskPath(
  cfg: AppConfig,
  taskId: string,
): Promise<{ dir: string; record: TaskRecord } | null> {
  const file = await findTaskPath(cfg, taskId);
  if (!file) return null;
  const record = await readJsonParsed(file, TaskRecordSchema, null as unknown as TaskRecord);
  if (!record) return null;
  return { dir: path.dirname(file), record };
}
