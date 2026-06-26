#!/usr/bin/env node
// Token usage reporter for Felix. Reads daily-partitioned usage JSONL from
// $WORKSPACE_DIR/usage and prints today / this week / this month / all-time
// totals plus per-contact/source/model/thread breakdowns.
//
// Usage: node report.mjs [today|week|month|all]   (default: all windows)
//
// Self-contained on purpose: the skill runs in the agent runtime, separate from
// the server process, so it cannot import the server's compiled aggregation. The
// windowing logic mirrors src/slices/usage + src/lib/time (keep them in sync).

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Max breakdown rows surfaced per dimension — must match ROW_LIMIT in
// web/src/pages/usage.tsx so the chat skill and owner console agree.
const ROW_LIMIT = 20;

const WORKSPACE = process.env.WORKSPACE_DIR || "/home/node/workspace";
const TZ = process.env.USAGE_TZ || "UTC";
const USAGE_DIR = path.join(WORKSPACE, "usage");

function tzDateKey(input) {
  const date = typeof input === "string" ? new Date(input) : input;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function weekStartKey(now) {
  const [y, m, d] = tzDateKey(now).split("-").map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  const isoDow = anchor.getUTCDay() === 0 ? 7 : anchor.getUTCDay();
  anchor.setUTCDate(anchor.getUTCDate() - (isoDow - 1));
  return anchor.toISOString().slice(0, 10);
}

function monthStartKey(now) {
  return `${tzDateKey(now).slice(0, 7)}-01`;
}

function inWindow(recordKey, window, now) {
  if (window === "all") return true;
  const today = tzDateKey(now);
  if (window === "today") return recordKey === today;
  const start = window === "week" ? weekStartKey(now) : monthStartKey(now);
  return recordKey >= start && recordKey <= today;
}

async function readAllRecords() {
  const entries = await fs.readdir(USAGE_DIR, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const raw = await fs.readFile(path.join(USAGE_DIR, e.name), "utf8").catch(() => "");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t);
        if (typeof r.total === "number" && typeof r.at === "string") records.push(r);
      } catch {
        // skip malformed
      }
    }
  }
  return records;
}

function aggregate(records, window, now) {
  const filtered = records.filter((r) => inWindow(tzDateKey(r.at), window, now));
  const totals = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, turns: 0 };
  const dims = { contact_id: new Map(), source: new Map(), model: new Map(), thread_key: new Map() };
  for (const r of filtered) {
    totals.input += r.input || 0;
    totals.output += r.output || 0;
    totals.cache_read += r.cache_read || 0;
    totals.cache_write += r.cache_write || 0;
    totals.total += r.total || 0;
    totals.turns += 1;
    for (const dim of Object.keys(dims)) {
      const key = String(r[dim] ?? "(unknown)") || "(unknown)";
      dims[dim].set(key, (dims[dim].get(key) || 0) + (r.total || 0));
    }
  }
  const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    totals,
    byContact: sortDesc(dims.contact_id),
    bySource: sortDesc(dims.source),
    byModel: sortDesc(dims.model),
    byThread: sortDesc(dims.thread_key),
  };
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");

function renderWindow(name, agg) {
  const t = agg.totals;
  const lines = [`### ${name}`];
  if (t.turns === 0) {
    lines.push("No usage recorded.");
    return lines.join("\n");
  }
  lines.push(
    `- Total: **${fmt(t.total)}** tokens over ${fmt(t.turns)} turns (input ${fmt(t.input)}, output ${fmt(t.output)}` +
      (t.cache_read || t.cache_write ? `, cache ${fmt(t.cache_read)} read / ${fmt(t.cache_write)} write` : "") +
      ")",
  );
  const section = (label, rows) => {
    if (rows.length === 0) return;
    const shown = rows.slice(0, ROW_LIMIT).map(([k, v]) => `${k} (${fmt(v)})`);
    const suffix = rows.length > ROW_LIMIT ? ` … +${rows.length - ROW_LIMIT} more` : "";
    lines.push(`- ${label}: ` + shown.join(", ") + suffix);
  };
  section("By contact", agg.byContact);
  section("By source", agg.bySource);
  section("By model", agg.byModel);
  section("By thread", agg.byThread);
  return lines.join("\n");
}

async function main() {
  const arg = (process.argv[2] || "").toLowerCase();
  const now = new Date();
  const records = await readAllRecords();
  const windows = ["today", "week", "month", "all"].includes(arg)
    ? [arg]
    : ["today", "week", "month", "all"];
  const titles = { today: "Today", week: "This week", month: "This month", all: "All time" };
  const out = [`## Token usage (timezone: ${TZ})`];
  for (const w of windows) out.push(renderWindow(titles[w], aggregate(records, w, now)));
  process.stdout.write(out.join("\n\n") + "\n");
}

// Exported for the parity regression test (tests/usage.test.ts), which asserts
// this aggregation matches the server's aggregateRecords on identical fixtures.
export { aggregate, tzDateKey, weekStartKey, monthStartKey, inWindow };

// Only run the CLI when invoked directly (not when imported by the test).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`usage-report failed: ${err?.message || err}\n`);
    process.exit(1);
  });
}
