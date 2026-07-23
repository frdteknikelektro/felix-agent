import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import type { Harness, TurnInput } from "../../core/ports.js";
import { modelForMemorizing } from "../../core/harness-settings.js";
import { pathExists, writeTextAtomic } from "../../lib/fs.js";
import { log } from "../../lib/log.js";
import { tzDateKey } from "../../lib/time.js";
import { createOrLoadThread, type ThreadHandle } from "../sessions/index.js";

const MEMORY_SYSTEM_THREAD_KEY = "memory-system";
const DAY_MS = 86_400_000;

export interface MemoryMaintenanceResult {
  weeklyCreated: string[];
  monthlyCreated: string[];
  dailyDeleted: string[];
  weeklyDeleted: string[];
  monthlyDeleted: string[];
  failures: string[];
}

function emptyResult(): MemoryMaintenanceResult {
  return {
    weeklyCreated: [],
    monthlyCreated: [],
    dailyDeleted: [],
    weeklyDeleted: [],
    monthlyDeleted: [],
    failures: [],
  };
}

function dateFromKey(key: string): Date {
  return new Date(`${key}T12:00:00.000Z`);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(key: string, days: number): string {
  return dateKey(new Date(dateFromKey(key).getTime() + days * DAY_MS));
}

function weekStartForKey(key: string): string {
  const date = dateFromKey(key);
  const isoDay = date.getUTCDay() || 7;
  return addDays(key, 1 - isoDay);
}

function monthKeyForDate(key: string): string {
  return key.slice(0, 7);
}

function addMonths(month: string, count: number): string {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, value! - 1 + count, 1, 12));
  return date.toISOString().slice(0, 7);
}

function monthLastDate(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return dateKey(new Date(Date.UTC(year!, value!, 0, 12)));
}

type PeriodKind = "daily" | "weekly" | "monthly";

function validPeriodKey(key: string, kind: PeriodKind): boolean {
  if (kind === "monthly") {
    const date = dateFromKey(`${key}-01`);
    return !Number.isNaN(date.getTime()) && dateKey(date).slice(0, 7) === key;
  }
  const date = dateFromKey(key);
  if (Number.isNaN(date.getTime()) || dateKey(date) !== key) return false;
  return kind !== "weekly" || date.getUTCDay() === 1;
}

async function listPeriodKeys(dir: string, kind: PeriodKind): Promise<string[]> {
  const pattern = kind === "monthly"
    ? /^\d{4}-\d{2}\.md$/
    : /^\d{4}-\d{2}-\d{2}\.md$/;
  return (await fs.readdir(dir))
    .filter((entry) => pattern.test(entry))
    .map((entry) => entry.slice(0, -3))
    .filter((key) => validPeriodKey(key, kind))
    .sort();
}

async function readSafeMarkdown(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("not a regular file");
  }
  const text = await fs.readFile(file, "utf8");
  if (text.includes("\0") || text.includes("\uFFFD")) {
    throw new Error("not readable UTF-8 Markdown");
  }
  return text;
}

type CoverageInspection =
  | { state: "missing" | "empty" | "covered" }
  | { state: "unreadable"; error: string };

async function inspectCoverage(file: string): Promise<CoverageInspection> {
  try {
    const text = await readSafeMarkdown(file);
    return { state: text.trim().length > 0 ? "covered" : "empty" };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}

function coverageFailure(file: string, inspection: Extract<CoverageInspection, { state: "unreadable" }>): string {
  return `${path.basename(file)}: ${inspection.error}`;
}

async function memorySystemThread(cfg: AppConfig, now: Date): Promise<ThreadHandle> {
  return createOrLoadThread(cfg, {
    source: "system",
    thread_key: MEMORY_SYSTEM_THREAD_KEY,
    source_thread_ref: null as never,
    received_at: now.toISOString(),
  });
}

function maintenanceInput(
  cfg: AppConfig,
  thread: ThreadHandle,
  now: Date,
  kind: "weekly" | "monthly",
  period: string,
  sourceFiles: string[],
  sourceContents: string[],
): TurnInput {
  const monthRule = kind === "monthly"
    ? `Include only events whose attributed date is within ${period}, even when a source week crosses a month boundary.`
    : "Preserve the original event dates from the daily sources.";
  const prompt = [
    "Create a concise human-style Memory rollup from the listed source files.",
    "Retain only what a person would need to remember; omit routine or unimportant detail.",
    "Do not invent facts. Preserve unresolved contradictions and their source/date.",
    "Exclude secrets, credentials, auth/recovery material, platform IDs, raw transcripts, attachments, and unnecessary personal information.",
    "Return only readable Markdown inside FELIX_REPLY. Do not write any files.",
    "If nothing should be retained, return a Markdown heading and an explicit _No events retained._ line.",
    "",
    `Kind: ${kind}`,
    `Period: ${period}`,
    `Owner timezone: ${cfg.OWNER_TZ}`,
    monthRule,
    "Sources:",
    ...sourceFiles.map((file, index) => `- ${file}\n  Source snapshot (read-only):\n${sourceContents[index] ?? ""}`),
  ].join("\n");

  return {
    thread,
    event: {
      source: "system",
      thread_key: MEMORY_SYSTEM_THREAD_KEY,
      event_id: `memory-${kind}-${period}-${now.getTime()}`,
      received_at: now.toISOString(),
      visibility: "channel",
      mentions_bot: false,
      sender: { source: "system", id: "memory-maintenance" },
      text: "",
      attachments: [],
      raw_path: "",
      source_thread_ref: null as never,
    },
    eventFile: "",
    contact: {
      user_id: "memory-maintenance",
      source: "system",
      display: "Memory Maintenance",
      allowed_permissions: ["memory:write"],
    },
    skills: [],
    sourceContext: { behaviorInstructions: [] },
    requesterIsOwner: true,
    resumed: false,
    promptOverride: prompt,
    modelOverride: modelForMemorizing(cfg),
  };
}

function isoDates(text: string): string[] {
  return [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]!);
}

function validateRollupMarkdown(
  markdown: string,
  kind: "weekly" | "monthly",
  period: string,
  sourceFiles: string[],
  sourceContents: string[],
): void {
  const sourceDates = new Set<string>([
    ...sourceFiles.flatMap((file) => isoDates(path.basename(file))),
    ...sourceContents.flatMap(isoDates),
  ]);
  const trimmed = markdown.trim();
  const isExplicitEmpty = /^\s*(?:#{1,6}\s+[^\n]+\s*)?_No events retained\._\s*$/i.test(trimmed);
  if (isExplicitEmpty) return;
  const outputDates = isoDates(markdown);
  const crossesMonth = kind === "weekly" && monthKeyForDate(period) !== monthKeyForDate(addDays(period, 6));
  if (crossesMonth && sourceFiles.length > 0 && outputDates.length === 0) {
    throw new Error("cross-month weekly rollup must preserve source event dates");
  }
  for (const date of outputDates) {
    const inPeriod = kind === "weekly"
      ? weekStartForKey(date) === period
      : monthKeyForDate(date) === period;
    if (!inPeriod || !sourceDates.has(date)) {
      throw new Error(`rollup date ${date} is not grounded in the ${kind} source period`);
    }
  }
}

async function unlinkIfUnchanged(file: string): Promise<void> {
  const before = await readSafeMarkdown(file);
  const current = await readSafeMarkdown(file);
  if (current !== before) throw new Error("file changed during retention; preserving it");
  await fs.unlink(file);
}

async function coverageIsFresh(output: string, sourceFiles: string[]): Promise<boolean> {
  try {
    const outputStat = await fs.lstat(output);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) return false;
    for (const source of sourceFiles) {
      const sourceStat = await fs.lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.mtimeMs > outputStat.mtimeMs) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function createRollup(
  cfg: AppConfig,
  harness: Harness,
  thread: ThreadHandle,
  now: Date,
  kind: "weekly" | "monthly",
  period: string,
  sourceFiles: string[],
  outputFile: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before: string[] = [];
    for (const file of sourceFiles) {
      try {
        before.push(await readSafeMarkdown(file));
      } catch (error) {
        throw new Error(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const result = await harness.run(maintenanceInput(cfg, thread, now, kind, period, sourceFiles, before));
    if (!result.success) {
      throw new Error(`low-cost model failed (exit ${result.exitCode})`);
    }
    const markdown = result.parsed.text;
    if (result.parsed.kind !== "reply" || !markdown.trim()) {
      throw new Error("low-cost model returned no Markdown");
    }
    validateRollupMarkdown(markdown, kind, period, sourceFiles, before);

    let changed = false;
    for (let index = 0; index < sourceFiles.length; index += 1) {
      try {
        if (await readSafeMarkdown(sourceFiles[index]!) !== before[index]) changed = true;
      } catch {
        changed = true;
      }
    }
    if (changed) {
      log.warn("memory: source changed during rollup; retrying", { kind, period, attempt });
      continue;
    }
    if (await pathExists(outputFile)) {
      const outputStatus = await inspectCoverage(outputFile);
      if (outputStatus.state === "unreadable") throw new Error("output changed to an unsafe file");
    }
    await writeTextAtomic(outputFile, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    return;
  }
  throw new Error("sources kept changing during rollup");
}

function weeksIntersectingMonth(month: string): string[] {
  const first = `${month}-01`;
  const last = monthLastDate(month);
  const weeks: string[] = [];
  for (let week = weekStartForKey(first); week <= weekStartForKey(last); week = addDays(week, 7)) {
    weeks.push(week);
  }
  return weeks;
}

async function buildWeeklyRollups(
  cfg: AppConfig,
  harness: Harness,
  thread: ThreadHandle,
  now: Date,
  currentWeek: string,
  result: MemoryMaintenanceResult,
): Promise<void> {
  const dailyKeys = await listPeriodKeys(cfg.paths.memoryDailyDir, "daily");
  const candidates = new Set<string>([addDays(currentWeek, -7)]);
  if (dailyKeys.length > 0) {
    const oldestMonthStart = `${dailyKeys[0]!.slice(0, 7)}-01`;
    const oldestWeek = weekStartForKey(oldestMonthStart);
    for (let week = oldestWeek; week < currentWeek; week = addDays(week, 7)) {
      candidates.add(week);
    }
  }

  for (const week of [...candidates].sort()) {
    const output = path.join(cfg.paths.memoryWeeklyDir, `${week}.md`);
    const sourceFiles = dailyKeys
      .filter((day) => day >= week && day <= addDays(week, 6))
      .map((day) => path.join(cfg.paths.memoryDailyDir, `${day}.md`));
    const outputStatus = await inspectCoverage(output);
    if (outputStatus.state === "covered" && await coverageIsFresh(output, sourceFiles)) continue;
    if (outputStatus.state === "unreadable") {
      const message = coverageFailure(output, outputStatus);
      result.failures.push(message);
      log.error("memory: weekly output is unreadable", { period: week, error: message });
      continue;
    }
    try {
      await createRollup(cfg, harness, thread, now, "weekly", week, sourceFiles, output);
      result.weeklyCreated.push(week);
    } catch (error) {
      const message = `${week}.md: ${error instanceof Error ? error.message : String(error)}`;
      result.failures.push(message);
      log.error("memory: weekly rollup failed", { period: week, error: message });
    }
  }
}

async function buildMonthlyRollups(
  cfg: AppConfig,
  harness: Harness,
  thread: ThreadHandle,
  now: Date,
  currentWeek: string,
  currentMonth: string,
  result: MemoryMaintenanceResult,
): Promise<void> {
  const weeklyKeys = await listPeriodKeys(cfg.paths.memoryWeeklyDir, "weekly");
  const candidates = new Set<string>([addMonths(currentMonth, -1)]);
  for (const week of weeklyKeys) {
    for (let day = week; day <= addDays(week, 6); day = addDays(day, 1)) {
      const month = monthKeyForDate(day);
      if (month < currentMonth) candidates.add(month);
    }
  }

  for (const month of [...candidates].sort()) {
    const output = path.join(cfg.paths.memoryMonthlyDir, `${month}.md`);
    const weeks = weeksIntersectingMonth(month);
    if (weeks.some((week) => week >= currentWeek)) continue;
    const sourceFiles = weeks.map((week) => path.join(cfg.paths.memoryWeeklyDir, `${week}.md`));
    const outputStatus = await inspectCoverage(output);
    if (outputStatus.state === "covered" && await coverageIsFresh(output, sourceFiles)) continue;
    if (outputStatus.state === "unreadable") {
      const message = coverageFailure(output, outputStatus);
      result.failures.push(message);
      log.error("memory: monthly output is unreadable", { period: month, error: message });
      continue;
    }
    const sourceStatuses = await Promise.all(sourceFiles.map(inspectCoverage));
    const unreadableSources = sourceFiles.flatMap((file, index) => {
      const status = sourceStatuses[index]!;
      return status.state === "unreadable" ? [coverageFailure(file, status)] : [];
    });
    if (unreadableSources.length > 0) {
      result.failures.push(...unreadableSources);
      log.error("memory: monthly source is unreadable", { period: month, errors: unreadableSources });
      continue;
    }
    if (!sourceStatuses.every((status) => status.state === "covered")) continue;
    try {
      await createRollup(cfg, harness, thread, now, "monthly", month, sourceFiles, output);
      result.monthlyCreated.push(month);
    } catch (error) {
      const message = `${month}.md: ${error instanceof Error ? error.message : String(error)}`;
      result.failures.push(message);
      log.error("memory: monthly rollup failed", { period: month, error: message });
    }
  }
}

async function enforceRetention(
  cfg: AppConfig,
  today: string,
  currentWeek: string,
  currentMonth: string,
  result: MemoryMaintenanceResult,
): Promise<void> {
  const dailyCutoff = addDays(today, -7);
  for (const day of await listPeriodKeys(cfg.paths.memoryDailyDir, "daily")) {
    if (day > dailyCutoff) continue;
    const coverage = path.join(cfg.paths.memoryWeeklyDir, `${weekStartForKey(day)}.md`);
    const coverageStatus = await inspectCoverage(coverage);
    if (coverageStatus.state === "unreadable") {
      const message = coverageFailure(coverage, coverageStatus);
      result.failures.push(message);
      log.error("memory: daily retention coverage is unreadable", { day, error: message });
      continue;
    }
    if (coverageStatus.state !== "covered") continue;
    const file = path.join(cfg.paths.memoryDailyDir, `${day}.md`);
    try {
      await unlinkIfUnchanged(file);
      result.dailyDeleted.push(day);
    } catch (error) {
      result.failures.push(`${day}.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const weeklyCutoff = addDays(currentWeek, -42);
  for (const week of await listPeriodKeys(cfg.paths.memoryWeeklyDir, "weekly")) {
    if (week > weeklyCutoff) continue;
    const months = new Set<string>();
    for (let day = week; day <= addDays(week, 6); day = addDays(day, 1)) {
      months.add(monthKeyForDate(day));
    }
    const coverage = [...months].map((month) => path.join(cfg.paths.memoryMonthlyDir, `${month}.md`));
    const coverageStatuses = await Promise.all(coverage.map(inspectCoverage));
    const unreadableCoverage = coverage.flatMap((file, index) => {
      const status = coverageStatuses[index]!;
      return status.state === "unreadable" ? [coverageFailure(file, status)] : [];
    });
    if (unreadableCoverage.length > 0) {
      result.failures.push(...unreadableCoverage);
      log.error("memory: weekly retention coverage is unreadable", { week, errors: unreadableCoverage });
      continue;
    }
    if (!coverageStatuses.every((status) => status.state === "covered")) continue;
    const file = path.join(cfg.paths.memoryWeeklyDir, `${week}.md`);
    try {
      await unlinkIfUnchanged(file);
      result.weeklyDeleted.push(week);
    } catch (error) {
      result.failures.push(`${week}.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const monthlyCutoff = addMonths(currentMonth, -12);
  for (const month of await listPeriodKeys(cfg.paths.memoryMonthlyDir, "monthly")) {
    if (month >= monthlyCutoff) continue;
    const file = path.join(cfg.paths.memoryMonthlyDir, `${month}.md`);
    try {
      await unlinkIfUnchanged(file);
      result.monthlyDeleted.push(month);
    } catch (error) {
      result.failures.push(`${month}.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function runMemoryMaintenance(
  cfg: AppConfig,
  harness: Harness,
  now = new Date(),
): Promise<MemoryMaintenanceResult> {
  const result = emptyResult();
  const today = tzDateKey(now, cfg.OWNER_TZ);
  const currentWeek = weekStartForKey(today);
  const currentMonth = monthKeyForDate(today);
  let thread: ThreadHandle;
  try {
    await Promise.all([
      listPeriodKeys(cfg.paths.memoryDailyDir, "daily"),
      listPeriodKeys(cfg.paths.memoryWeeklyDir, "weekly"),
      listPeriodKeys(cfg.paths.memoryMonthlyDir, "monthly"),
    ]);
    modelForMemorizing(cfg);
    thread = await memorySystemThread(cfg, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.failures.push(message);
    log.error("memory: maintenance unavailable", { error: message });
    return result;
  }

  await buildWeeklyRollups(cfg, harness, thread, now, currentWeek, result);
  await buildMonthlyRollups(cfg, harness, thread, now, currentWeek, currentMonth, result);
  if (result.failures.length === 0) {
    await enforceRetention(cfg, today, currentWeek, currentMonth, result);
  } else {
    log.warn("memory: retention skipped because rollup maintenance was incomplete", {
      failures: result.failures.length,
    });
  }
  log.info("memory: maintenance complete", {
    weeklyCreated: result.weeklyCreated.length,
    monthlyCreated: result.monthlyCreated.length,
    dailyDeleted: result.dailyDeleted.length,
    weeklyDeleted: result.weeklyDeleted.length,
    monthlyDeleted: result.monthlyDeleted.length,
    failures: result.failures.length,
  });
  return result;
}
