#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseNamedArgs } from "./cli-args.mjs";
import {
  MANUAL_ACCEPTANCE_MARKDOWN,
  verifyManualReleaseEvidence,
} from "./manual-release-evidence.mjs";
import { writeFileAtomic } from "./setup-support.mjs";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

const PLACEHOLDER_PATTERN = /\b(?:TBD|PENDING)\b/i;

function parseArgs(argv) {
  return Object.fromEntries([...parseNamedArgs(argv)].map(([name, value]) => [
    name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
    value,
  ]));
}

export async function generateReleaseEvidence(input) {
  const required = [
    "version", "candidateRunId", "candidateCommit", "imageDigest", "acceptanceRunId",
    "scan", "sbom", "provenance", "manual", "artifactDir", "output",
  ];
  for (const field of required) {
    if (!input[field]) throw new Error(`${field} is required`);
    if (PLACEHOLDER_PATTERN.test(String(input[field]))) throw new Error(`${field} must not contain a placeholder`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error("version must be a semantic version without a v prefix");
  if (!/^\d+$/.test(input.candidateRunId)) throw new Error("candidate run ID must be numeric");
  if (!/^\d+$/.test(input.acceptanceRunId)) throw new Error("acceptance run ID must be numeric");
  if (!/^[0-9a-f]{40}$/.test(input.candidateCommit)) throw new Error("candidate commit must be a full SHA-1");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) throw new Error("image digest must be sha256:<64 lowercase hex characters>");
  if (path.resolve(input.manual) !== path.resolve(input.artifactDir, MANUAL_ACCEPTANCE_MARKDOWN)) {
    throw new Error(`manual evidence must be ${MANUAL_ACCEPTANCE_MARKDOWN} in the release artifact directory`);
  }
  await verifyManualReleaseEvidence({
    version: input.version,
    candidateRunId: input.candidateRunId,
    candidateCommit: input.candidateCommit,
    imageDigest: input.imageDigest,
    acceptanceRunId: input.acceptanceRunId,
    evidenceDir: input.artifactDir,
    allowAdditionalFiles: true,
  });

  const artifacts = await Promise.all([input.scan, input.sbom, input.provenance, input.manual].map(async (file) => {
    const content = await readFile(file, "utf8");
    if (!content.trim()) throw new Error(`evidence artifact is empty: ${file}`);
    if (PLACEHOLDER_PATTERN.test(content)) throw new Error(`evidence artifact contains a placeholder: ${file}`);
    return { file, content, sha256: digest(content) };
  }));
  const [scan, sbom, provenance, manual] = artifacts;
  const outputPath = path.resolve(input.output);
  const directoryEntries = await readdir(input.artifactDir, { withFileTypes: true });
  const unsupported = directoryEntries.filter((entry) => !entry.isFile());
  if (unsupported.length > 0) {
    throw new Error(`release artifact directory contains a non-file entry: ${unsupported[0].name}`);
  }
  const releaseAssets = await Promise.all(directoryEntries
    .map((entry) => path.join(input.artifactDir, entry.name))
    .filter((file) => path.resolve(file) !== outputPath)
    .sort()
    .map(async (file) => {
      const content = await readFile(file);
      if (content.length === 0) throw new Error(`release artifact is empty: ${file}`);
      return { name: path.basename(file), sha256: digest(content) };
    }));
  if (releaseAssets.length === 0) throw new Error("release artifact directory is empty");
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
    "## Release assets",
    "",
    "| Asset | SHA-256 |",
    "|---|---|",
    ...releaseAssets.map((artifact) => `| ${artifact.name} | ${artifact.sha256} |`),
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
