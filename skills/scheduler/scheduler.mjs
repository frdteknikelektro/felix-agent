#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const workspace = process.env.WORKSPACE_DIR;
if (!workspace) fail("WORKSPACE_DIR is not set.");
const jobsDir = path.join(workspace, "scheduler", "jobs");
const logsDir = path.join(workspace, "scheduler", "logs");
const [command, ...args] = process.argv.slice(2);

try {
  if (command === "create") await create();
  else if (command === "list") await list(args[0]);
  else if (command === "show") await show(requireId(args[0]));
  else if (command === "update") await update(requireId(args[0]));
  else if (command === "delete") await remove(requireId(args[0]));
  else if (command === "run-now") await runNow(requireId(args[0]));
  else fail("Usage: scheduler.mjs <create|list|show|update|delete|run-now>");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function create() {
  const input = JSON.parse(await readStdin());
  for (const field of ["name", "prompt", "schedule", "created_by", "source_thread_ref", "source_thread_key"]) {
    if (!input[field]) fail(`create requires ${field}.`);
  }
  if (!input.next_run_at || Number.isNaN(Date.parse(input.next_run_at))) fail("create requires a valid resolved next_run_at.");
  if (!input.schedule.type || (!input.schedule.expression && !input.schedule.intervalMs)) fail("schedule must be resolved to expression or intervalMs.");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    ...input,
    id,
    run_once: Boolean(input.run_once),
    permissions: Array.isArray(input.permissions) ? input.permissions : [],
    output: input.output ?? "ringkas",
    retry: input.retry ?? { max_attempts: 3, backoff_ms: 5000 },
    status: "active",
    last_run_at: null,
    created_at: now,
    updated_at: now,
  };
  await fs.mkdir(jobsDir, { recursive: true });
  await writeNew(path.join(jobsDir, `${id}.json`), job);
  process.stdout.write(`✓ Scheduler job \`${id}\` created [active].\n`);
}

async function list(status) {
  await fs.mkdir(jobsDir, { recursive: true });
  const jobs = [];
  for (const name of await fs.readdir(jobsDir)) {
    if (!name.endsWith(".json")) continue;
    const job = await read(path.join(jobsDir, name));
    if (!status || job.status === status) jobs.push(job);
  }
  jobs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
}

async function show(id) {
  const job = await find(id);
  const executions = [];
  const dir = path.join(logsDir, id);
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (name.endsWith(".json")) executions.push(await read(path.join(dir, name)));
  }
  executions.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  process.stdout.write(`${JSON.stringify({ ...job, executions }, null, 2)}\n`);
}

async function update(id) {
  const changes = JSON.parse(await readStdin());
  const job = await find(id);
  if (changes.schedule && (!changes.schedule.expression && !changes.schedule.intervalMs)) fail("schedule must be resolved to expression or intervalMs.");
  const updated = { ...job, ...changes, updated_at: new Date().toISOString() };
  if (updated.status !== "active") updated.next_run_at = null;
  await write(path.join(jobsDir, `${id}.json`), updated);
  process.stdout.write(`Scheduler job \`${id}\` updated.\n`);
}

async function remove(id) {
  await find(id);
  await fs.unlink(path.join(jobsDir, `${id}.json`));
  await fs.rm(path.join(logsDir, id), { recursive: true, force: true });
  process.stdout.write(`Scheduler job \`${id}\` deleted.\n`);
}

async function runNow(id) {
  const job = await find(id);
  if (job.status !== "active") fail("Only active jobs can be triggered.");
  await write(path.join(jobsDir, `${id}.json`), { ...job, next_run_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  process.stdout.write(`Scheduler job \`${id}\` queued for immediate execution.\n`);
}

async function find(id) {
  const file = path.join(jobsDir, `${id}.json`);
  try { return await read(file); } catch { fail(`Scheduler job not found: \`${id}\`.`); }
}

async function read(file) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (!value || typeof value !== "object" || typeof value.id !== "string") fail(`Invalid scheduler job: ${file}`);
  return value;
}

async function write(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}

async function writeNew(file, value) {
  try { await fs.access(file); fail(`Refusing to overwrite existing scheduler job: ${file}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await write(file, value);
}

function requireId(value) {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) fail("A valid scheduler job ID is required.");
  return value;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  if (!data.trim()) fail("This command requires a JSON object on stdin.");
  return data;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
