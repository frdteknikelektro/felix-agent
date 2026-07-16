#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "./setup-support.mjs";

const SECRET_FIELDS = ["RuleID", "Category", "Severity", "Title", "StartLine", "EndLine", "Layer"];
const METADATA_FIELDS = ["OS", "ImageID", "DiffIDs", "RepoTags", "RepoDigests", "Architecture", "Size"];
const RESULT_CONTEXT_FIELDS = ["Target", "Class", "Type"];

function pick(object, fields) {
  return Object.fromEntries(fields.filter((field) => object?.[field] !== undefined).map((field) => [field, object[field]]));
}

/** Remove matched credentials and source excerpts while preserving gate/audit metadata. */
export function sanitizeTrivyReport(report) {
  return {
    ...report,
    ...(report.Metadata ? { Metadata: pick(report.Metadata, METADATA_FIELDS) } : {}),
    Results: (report.Results ?? []).map((result) => ({
      ...result,
      ...(Array.isArray(result.Secrets)
        ? { Secrets: result.Secrets.map((secret) => pick(secret, SECRET_FIELDS)) }
        : {}),
      ...(Array.isArray(result.Misconfigurations)
        ? { Misconfigurations: result.Misconfigurations.map(({ CauseMetadata: _cause, ...finding }) => finding) }
        : {}),
    })),
  };
}

/** Produce a focused report from an already sanitized report. */
export function selectTrivyFindings(report, field) {
  return {
    SchemaVersion: report.SchemaVersion,
    ArtifactName: report.ArtifactName,
    ArtifactType: report.ArtifactType,
    Results: (report.Results ?? [])
      .filter((result) => Array.isArray(result[field]) && result[field].length > 0)
      .map((result) => ({ ...pick(result, RESULT_CONTEXT_FIELDS), [field]: result[field] })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (![4, 5, 6].includes(process.argv.length)) {
      throw new Error("usage: sanitize-trivy-report.mjs <input.json> <output.json> [secrets-output.json] [misconfigurations-output.json]");
    }
    const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const sanitized = sanitizeTrivyReport(report);
    writeFileAtomic(process.argv[3], `${JSON.stringify(sanitized, null, 2)}\n`, 0o600);
    if (process.argv[4]) {
      const secrets = selectTrivyFindings(sanitized, "Secrets");
      writeFileAtomic(process.argv[4], `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
    }
    if (process.argv[5]) {
      const misconfigurations = selectTrivyFindings(sanitized, "Misconfigurations");
      writeFileAtomic(process.argv[5], `${JSON.stringify(misconfigurations, null, 2)}\n`, 0o600);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
