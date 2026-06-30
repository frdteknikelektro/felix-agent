#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const STATUSES = ["backlog", "active", "done", "cancelled", "blocked", "paused"];
const TRANSITIONS = new Map([
  ["start", "active"],
  ["active", "active"],
  ["done", "done"],
  ["complete", "done"],
  ["cancel", "cancelled"],
  ["cancelled", "cancelled"],
  ["block", "blocked"],
  ["blocked", "blocked"],
  ["pause", "paused"],
  ["paused", "paused"],
  ["reopen", "backlog"],
  ["backlog", "backlog"],
]);

const workspaceDir = process.env.WORKSPACE_DIR;
if (!workspaceDir) fail("WORKSPACE_DIR is not set.");
const tasksDir = path.join(workspaceDir, "tasks");

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "create":
      await createTask();
      break;
    case "board":
      await printBoard();
      break;
    case "show":
      await showTask(requireTaskId(args[0]));
      break;
    case "transition":
      await transitionTask(requireTaskId(args[0]), args[1]);
      break;
    default:
      fail("Usage: task.mjs <create|board|show|transition>");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function createTask() {
  const input = JSON.parse(await readStdin());
  const title = requiredString(input.title, "title");
  const description = requiredString(input.description, "description");
  const source = requiredString(input.source, "source");
  const userId = requiredString(input.user_id, "user_id");
  const parentSource = optionalString(input.parent_source) ?? source;
  const parentThreadKey = requiredString(input.parent_thread_key, "parent_thread_key");
  const parentPostId = optionalString(input.parent_post_id);

  await ensureStatusDirs();
  const baseId = `${Math.floor(Date.now() / 1000)}-${slugify(title)}`;
  const id = await uniqueId(baseId);
  const now = new Date().toISOString();
  const task = {
    schema_version: 1,
    id,
    status: "backlog",
    title,
    description,
    created_at: now,
    created_by: { source, user_id: userId },
    parent_source: parentSource,
    parent_thread_key: parentThreadKey,
    parent_post_id: parentPostId,
    started_at: null,
    completed_at: null,
    updated_at: now,
  };

  const destination = path.join(tasksDir, "backlog", `${id}.json`);
  await writeNewJson(destination, task);
  process.stdout.write(`✓ Task \`${id}\` "${title}" created [backlog].\n`);
}

async function printBoard() {
  await ensureStatusDirs();
  const tasks = [];
  for (const status of STATUSES) {
    for (const file of await fs.readdir(path.join(tasksDir, status))) {
      if (!file.endsWith(".json")) continue;
      const task = await readTaskFile(path.join(tasksDir, status, file));
      tasks.push({ ...task, status });
    }
  }

  if (tasks.length === 0) {
    process.stdout.write('No tasks yet. Create one with "create task: ...".\n');
    return;
  }

  tasks.sort((a, b) => {
    const statusOrder = STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
    return statusOrder || String(b.updated_at).localeCompare(String(a.updated_at));
  });
  const lines = [
    "| Status    | Task ID                    | Title                 | Updated             |",
    "|-----------|----------------------------|-----------------------|---------------------|",
    ...tasks.map((task) =>
      `| ${cell(task.status)} | ${cell(task.id)} | ${cell(task.title)} | ${cell(task.updated_at)} |`,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function showTask(id) {
  const found = await findTask(id);
  if (!found) fail(`Task not found: \`${id}\`.`);
  const task = found.task;
  process.stdout.write([
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${found.status}`,
    `Description: ${task.description}`,
    `Created: ${task.created_at} by ${task.created_by?.source}:${task.created_by?.user_id}`,
    `Started: ${task.started_at ?? "-"}`,
    `Completed: ${task.completed_at ?? "-"}`,
    `Parent thread: ${task.parent_source} ${task.parent_thread_key}`,
    "",
  ].join("\n"));
}

async function transitionTask(id, verb) {
  const target = TRANSITIONS.get(verb);
  if (!target) fail(`Unknown transition: ${verb ?? "(missing)"}.`);
  const found = await findTask(id);
  if (!found) fail(`Task not found: \`${id}\`.`);
  if (found.status === target) {
    process.stdout.write(`Task \`${id}\` is already ${target}.\n`);
    return;
  }

  const now = new Date().toISOString();
  const task = { ...found.task, status: target, updated_at: now };
  if (target === "active") {
    task.started_at ??= now;
    task.completed_at = null;
  } else if (target === "done") {
    task.completed_at ??= now;
  } else if (target === "backlog") {
    task.started_at = null;
    task.completed_at = null;
  }

  const destination = path.join(tasksDir, target, `${id}.json`);
  await fs.access(destination).then(
    () => fail(`Refusing to overwrite existing task: ${destination}`),
    () => undefined,
  );
  await atomicReplaceJson(found.file, task);
  await fs.rename(found.file, destination);
  process.stdout.write(`Task \`${id}\` → ${target}.\n`);
}

async function findTask(id) {
  await ensureStatusDirs();
  const matches = [];
  for (const status of STATUSES) {
    const file = path.join(tasksDir, status, `${id}.json`);
    try {
      const task = await readTaskFile(file);
      matches.push({ status, file, task });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (matches.length > 1) fail(`Task ID exists in multiple statuses: ${id}.`);
  return matches[0];
}

async function ensureStatusDirs() {
  await Promise.all(STATUSES.map((status) => fs.mkdir(path.join(tasksDir, status), { recursive: true })));
}

async function uniqueId(base) {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!(await findTask(candidate))) return candidate;
  }
}

async function readTaskFile(file) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (!value || typeof value !== "object" || typeof value.id !== "string") {
    throw new Error(`Invalid task file: ${file}`);
  }
  return value;
}

async function writeNewJson(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, serialize(value), { flag: "wx", mode: 0o600 });
  try {
    await fs.link(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function atomicReplaceJson(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, serialize(value), { flag: "wx", mode: 0o600 });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "task";
}

function requireTaskId(value) {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) fail("A valid task ID is required.");
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`create requires a nonempty ${field}.`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  if (!data.trim()) fail("create requires a JSON object on stdin.");
  return data;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
