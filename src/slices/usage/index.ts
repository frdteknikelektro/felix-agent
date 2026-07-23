import path from "node:path";
import fs from "node:fs/promises";
import { appendText, readText } from "../../lib/fs.js";
import { tzDateKey, weekStartKey, monthStartKey, dateKeyRange } from "../../lib/time.js";
import { UsageRecordSchema } from "../../core/schemas.js";
import type { UsageRecord } from "../../types.js";
import type { AppConfig } from "../../config.js";
export { deltaCumulative, resolveContactId, type CumulativeTotals } from "../sessions/index.js";

export type UsageWindow = "today" | "week" | "month" | "all";
export const USAGE_WINDOWS: UsageWindow[] = ["today", "week", "month", "all"];
export const USAGE_BREAKDOWN_ROW_LIMIT = 20;

export interface UsageTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
  turns: number;
}

export interface UsageBreakdownRow extends UsageTotals {
  key: string;
}

export interface UsageView {
  window: UsageWindow;
  tz: string;
  generatedAt: string;
  breakdownLimit: number;
  totals: UsageTotals;
  byContact: UsageBreakdownRow[];
  bySource: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byThread: UsageBreakdownRow[];
}

const TOKENS_TODAY_TTL_MS = 5000;
let tokensTodayCache: { dayKey: string; value: number; expiresAt: number } | null = null;

function usageDir(cfg: AppConfig): string {
  return cfg.paths.usage;
}

function usageFile(usageDirectory: string, dateKey: string): string {
  return path.join(usageDirectory, `${dateKey}.jsonl`);
}

/** Append one usage record, partitioned into the day file for its TZ-local date. */
export async function appendUsageRecord(cfg: AppConfig, record: UsageRecord): Promise<void> {
  const dateKey = tzDateKey(record.at, cfg.OWNER_TZ);
  await appendText(usageFile(usageDir(cfg), dateKey), `${JSON.stringify(record)}\n`);
}

export function parseUsageWindow(input: string | null | undefined): UsageWindow | null {
  return USAGE_WINDOWS.includes(input as UsageWindow) ? (input as UsageWindow) : null;
}

function shiftKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Day-file keys to read for a window, widened ±1 day to catch TZ-shifted rows. */
function candidateKeys(window: UsageWindow, now: Date, tz: string): string[] {
  const today = tzDateKey(now, tz);
  if (window === "today") return dateKeyRange(shiftKey(today, -1), shiftKey(today, 1));
  const start = window === "week" ? weekStartKey(now, tz) : monthStartKey(now, tz);
  return dateKeyRange(shiftKey(start, -1), shiftKey(today, 1));
}

function inWindow(recordKey: string, window: UsageWindow, now: Date, tz: string): boolean {
  if (window === "all") return true;
  const today = tzDateKey(now, tz);
  if (window === "today") return recordKey === today;
  const start = window === "week" ? weekStartKey(now, tz) : monthStartKey(now, tz);
  return recordKey >= start && recordKey <= today;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, turns: 0 };
}

function addInto(target: UsageTotals, r: UsageRecord): void {
  target.input += r.input;
  target.output += r.output;
  target.cache_read += r.cache_read;
  target.cache_write += r.cache_write;
  target.total += r.total;
  target.turns += 1;
}

function breakdown(records: UsageRecord[], keyOf: (r: UsageRecord) => string): UsageBreakdownRow[] {
  const map = new Map<string, UsageTotals>();
  for (const r of records) {
    const key = keyOf(r) || "(unknown)";
    let totals = map.get(key);
    if (!totals) {
      totals = emptyTotals();
      map.set(key, totals);
    }
    addInto(totals, r);
  }
  return [...map.entries()]
    .map(([key, totals]) => ({ key, ...totals }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Pure aggregation — filters `records` to `window` (TZ-localized) and rolls them
 * up into totals + the four breakdowns. No IO, so it is unit-tested directly and
 * reused by the usage-report skill.
 */
export function aggregateRecords(
  records: UsageRecord[],
  window: UsageWindow,
  tz: string,
  now: Date,
): UsageView {
  const filtered = records.filter((r) => inWindow(tzDateKey(r.at, tz), window, now, tz));
  const totals = emptyTotals();
  for (const r of filtered) addInto(totals, r);
  return {
    window,
    tz,
    generatedAt: now.toISOString(),
    breakdownLimit: USAGE_BREAKDOWN_ROW_LIMIT,
    totals,
    byContact: breakdown(filtered, (r) => r.contact_id),
    bySource: breakdown(filtered, (r) => r.source),
    byModel: breakdown(filtered, (r) => r.model ?? "(unknown)"),
    byThread: breakdown(filtered, (r) => r.thread_key),
  };
}

async function readDayFile(usageDirectory: string, dateKey: string): Promise<UsageRecord[]> {
  const raw = await readText(usageFile(usageDirectory, dateKey), "");
  if (!raw) return [];
  const out: UsageRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = UsageRecordSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // Skip malformed rows.
    }
  }
  return out;
}

async function allDayKeys(usageDirectory: string): Promise<string[]> {
  const entries = await fs.readdir(usageDirectory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => e.name.slice(0, -".jsonl".length));
}

export async function aggregateUsageFromDirectory(
  usageDirectory: string,
  tz: string,
  window: UsageWindow,
  now: Date = new Date(),
): Promise<UsageView> {
  const keys = window === "all" ? await allDayKeys(usageDirectory) : candidateKeys(window, now, tz);
  const records: UsageRecord[] = [];
  for (const key of keys) {
    records.push(...(await readDayFile(usageDirectory, key)));
  }
  return aggregateRecords(records, window, tz, now);
}

/** Read the day files a window needs and aggregate them into a {@link UsageView}. */
export async function aggregateUsage(
  cfg: AppConfig,
  window: UsageWindow,
  now: Date = new Date(),
): Promise<UsageView> {
  return aggregateUsageFromDirectory(usageDir(cfg), cfg.OWNER_TZ, window, now);
}

/** Windowed token-usage read model for the owner console Usage page. */
export async function usageView(cfg: AppConfig, window: UsageWindow, now: Date = new Date()): Promise<UsageView> {
  return aggregateUsage(cfg, window, now);
}

/** Cached dashboard read model for the live "tokens today" counter. */
export async function tokensToday(cfg: AppConfig, now: Date = new Date()): Promise<number> {
  const dayKey = tzDateKey(now, cfg.OWNER_TZ);
  if (tokensTodayCache && tokensTodayCache.dayKey === dayKey && now.getTime() < tokensTodayCache.expiresAt) {
    return tokensTodayCache.value;
  }
  const view = await aggregateUsage(cfg, "today", now);
  tokensTodayCache = { dayKey, value: view.totals.total, expiresAt: now.getTime() + TOKENS_TODAY_TTL_MS };
  return view.totals.total;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function usageWindowTitle(window: UsageWindow): string {
  switch (window) {
    case "today":
      return "Today";
    case "week":
      return "This week";
    case "month":
      return "This month";
    case "all":
      return "All time";
  }
}

function renderBreakdown(label: string, rows: UsageBreakdownRow[], limit: number): string | null {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, limit).map((row) => `${row.key} (${fmt(row.total)})`);
  const suffix = rows.length > limit ? ` ... +${rows.length - limit} more` : "";
  return `- ${label}: ${shown.join(", ")}${suffix}`;
}

export function renderUsageWindow(view: UsageView): string {
  const lines = [`### ${usageWindowTitle(view.window)}`];
  const t = view.totals;
  if (t.turns === 0) {
    lines.push("No usage recorded.");
    return lines.join("\n");
  }
  const turnLabel = t.turns === 1 ? "turn" : "turns";
  lines.push(
    `- Total: **${fmt(t.total)}** tokens over ${fmt(t.turns)} ${turnLabel} (input ${fmt(t.input)}, output ${fmt(t.output)}` +
      (t.cache_read || t.cache_write ? `, cache ${fmt(t.cache_read)} read / ${fmt(t.cache_write)} write` : "") +
      ")",
  );
  const limit = view.breakdownLimit;
  for (const line of [
    renderBreakdown("By contact", view.byContact, limit),
    renderBreakdown("By source", view.bySource, limit),
    renderBreakdown("By model", view.byModel, limit),
    renderBreakdown("By thread", view.byThread, limit),
  ]) {
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

export function renderUsageReport(views: UsageView[]): string {
  const tz = views[0]?.tz ?? "UTC";
  return [`## Token usage (timezone: ${tz})`, ...views.map(renderUsageWindow)].join("\n\n");
}

export async function usageReportFromDirectory(
  usageDirectory: string,
  tz: string,
  windows: UsageWindow[],
  now: Date = new Date(),
): Promise<string> {
  const views: UsageView[] = [];
  for (const window of windows) {
    views.push(await aggregateUsageFromDirectory(usageDirectory, tz, window, now));
  }
  return renderUsageReport(views);
}
