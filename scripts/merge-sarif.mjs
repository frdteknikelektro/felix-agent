#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "./setup-support.mjs";

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * Merge platform SARIF reports while assigning each run a distinct GitHub
 * code-scanning category through SARIF's automationDetails.id field.
 */
export function mergeSarifReports(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("at least one SARIF report is required");
  }

  const categories = new Set();
  const mergedRuns = [];
  let base;

  for (const [entryIndex, entry] of entries.entries()) {
    requireRecord(entry, `entry ${entryIndex + 1}`);
    const category = String(entry.category ?? "").trim().replace(/\/+$/, "");
    if (!category) throw new Error(`entry ${entryIndex + 1} must have a SARIF category`);
    if (categories.has(category)) throw new Error(`duplicate SARIF category: ${category}`);
    categories.add(category);

    const report = requireRecord(entry.report, `SARIF report ${category}`);
    if (!Array.isArray(report.runs) || report.runs.length === 0) {
      throw new Error(`SARIF report ${category} must contain at least one run`);
    }
    base ??= report;

    for (const [runIndex, runValue] of report.runs.entries()) {
      const run = requireRecord(runValue, `SARIF run ${category}#${runIndex + 1}`);
      const runCategory = report.runs.length === 1 ? category : `${category}-${runIndex + 1}`;
      if (runCategory !== category && categories.has(runCategory)) {
        throw new Error(`duplicate SARIF category: ${runCategory}`);
      }
      categories.add(runCategory);
      mergedRuns.push({
        ...run,
        automationDetails: {
          ...(requireRecord(run.automationDetails ?? {}, `SARIF automation details ${runCategory}`)),
          id: `${runCategory}/`,
        },
      });
    }
  }

  return { ...base, runs: mergedRuns };
}

function run() {
  const args = process.argv.slice(2);
  const output = args.shift();
  if (!output || args.length === 0 || args.length % 2 !== 0) {
    throw new Error(
      "usage: merge-sarif.mjs <output.sarif> <category> <input.sarif> [<category> <input.sarif> ...]",
    );
  }

  const entries = [];
  for (let index = 0; index < args.length; index += 2) {
    entries.push({
      category: args[index],
      report: JSON.parse(readFileSync(args[index + 1], "utf8")),
    });
  }
  writeFileAtomic(output, `${JSON.stringify(mergeSarifReports(entries), null, 2)}\n`, 0o600);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
