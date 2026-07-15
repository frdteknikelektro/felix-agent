#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "./setup-support.mjs";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

const PLACEHOLDER_PATTERN = /\b(?:TBD|PENDING)\b/i;
const REQUIRED_MANUAL_CHECKS = [
  "AMD64 and ARM64 runtime/lifecycle matrix passed",
  "Mattermost source matrix passed",
  "Discord source matrix passed",
  "Slack source matrix passed",
  "WhatsApp source matrix passed",
  "Telegram source matrix passed",
  "Codex harness matrix passed",
  "OpenCode harness matrix passed",
  "Claude Code harness matrix passed",
  "Dynamic bundled-skill and controlled Google Workspace matrix passed",
  "Backup, fresh-host restore, 0.1.0 upgrade, failed-upgrade simulation, and rollback passed",
  "Sensitive-log and evidence-redaction review passed",
  "Documentation and final digest-consistency review passed",
];

function hasBindingLine(content, label, value) {
  const expected = `- ${label}: ${value}`;
  return content.split(/\r?\n/).some((line) => line.replaceAll("`", "").trim() === expected);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    args[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return args;
}

export async function generateReleaseEvidence(input) {
  const required = [
    "version", "candidateRunId", "candidateCommit", "imageDigest",
    "scan", "sbom", "provenance", "manual", "output",
  ];
  for (const field of required) {
    if (!input[field]) throw new Error(`${field} is required`);
    if (PLACEHOLDER_PATTERN.test(String(input[field]))) throw new Error(`${field} must not contain a placeholder`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error("version must be a semantic version without a v prefix");
  if (!/^\d+$/.test(input.candidateRunId)) throw new Error("candidate run ID must be numeric");
  if (!/^[0-9a-f]{40}$/.test(input.candidateCommit)) throw new Error("candidate commit must be a full SHA-1");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) throw new Error("image digest must be sha256:<64 lowercase hex characters>");

  const artifacts = await Promise.all([input.scan, input.sbom, input.provenance, input.manual].map(async (file) => {
    const content = await readFile(file, "utf8");
    if (!content.trim()) throw new Error(`evidence artifact is empty: ${file}`);
    if (PLACEHOLDER_PATTERN.test(content)) throw new Error(`evidence artifact contains a placeholder: ${file}`);
    return { file, content, sha256: digest(content) };
  }));
  const [scan, sbom, provenance, manual] = artifacts;
  if (/^- \[ \]/m.test(manual.content)) throw new Error("manual evidence is incomplete");
  const manualLines = manual.content.split(/\r?\n/).map((line) => line.replaceAll("`", "").trim());
  for (const check of REQUIRED_MANUAL_CHECKS) {
    const prefix = `- [x] ${check}:`;
    if (!manualLines.some((line) => line.startsWith(prefix) && line.slice(prefix.length).trim().length > 0)) {
      throw new Error(`manual evidence is missing completed check: ${check}`);
    }
  }
  if (!manualLines.some((line) => line === `# Felix ${input.version} release evidence`)) {
    throw new Error("manual evidence version does not match");
  }
  for (const [label, value] of [
    ["Candidate run ID", input.candidateRunId],
    ["Candidate commit", input.candidateCommit],
    ["Candidate digest", input.imageDigest],
  ]) {
    if (!hasBindingLine(manual.content, label, value)) {
      throw new Error(`manual evidence ${label.toLowerCase()} does not match`);
    }
  }

  const evidence = [
    `# Felix ${input.version} release evidence`,
    "",
    "This manifest binds the accepted candidate to sanitized evidence. Artifact contents are retained separately.",
    "",
    `- Version: ${input.version}`,
    `- Candidate run ID: ${input.candidateRunId}`,
    `- Candidate commit: ${input.candidateCommit}`,
    `- Candidate image digest: ${input.imageDigest}`,
    "",
    "| Evidence | SHA-256 |",
    "|---|---|",
    `| Scan policy result | ${scan.sha256} |`,
    `| SBOM | ${sbom.sha256} |`,
    `| Provenance | ${provenance.sha256} |`,
    `| Manual acceptance | ${manual.sha256} |`,
    "",
  ].join("\n");
  if (PLACEHOLDER_PATTERN.test(evidence)) throw new Error("generated evidence contains a placeholder");
  writeFileAtomic(input.output, evidence, 0o600);
}

async function run() {
  await generateReleaseEvidence(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
