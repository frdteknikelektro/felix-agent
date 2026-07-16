#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseNamedArgs } from "./cli-args.mjs";
import { writeFileAtomic } from "./setup-support.mjs";

export const MANUAL_POLICY_NOTE = "This sanitized manifest contains fixed artifact names and SHA-256 references only. Do not include credentials, OAuth URLs, customer data, messages, phone numbers, prompts, or raw logs.";

export const MANUAL_ACCEPTANCE_CHECKS = Object.freeze([
  {
    id: "runtime-lifecycle",
    file: "runtime-lifecycle.json",
    label: "AMD64 and ARM64 runtime/lifecycle matrix passed",
    subchecks: [
      "clean-setup-env-creation",
      "config-env-mode-0600",
      ...["health", "login", "unauthenticated-api", "unauthenticated-sse", "disabled-sources", "read-only-rootfs", "restart-persistence", "graceful-shutdown", "crash-restart"]
        .flatMap((check) => [`amd64-${check}`, `arm64-${check}`]),
    ],
  },
  ...["mattermost", "discord", "slack", "whatsapp", "telegram"].map((source) => ({
    id: source,
    file: `${source}.json`,
    label: `${source === "whatsapp" ? "WhatsApp" : source[0].toUpperCase() + source.slice(1)} source matrix passed`,
    subchecks: [
      "dm", "group-or-channel-mention", "reply", "reaction", "attachment", "approval", "unauthorized-contact-rejection", "duplicate-delivery-rejection",
      ...(source === "whatsapp" ? ["webhook-authentication-disabled", "webhook-authentication-reconnecting"] : []),
      ...(source === "telegram" ? ["polling-mode", "authenticated-webhook-mode"] : []),
    ],
  })),
  ...[
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
    ["claude-code", "Claude Code"],
  ].map(([id, name]) => ({
    id,
    file: `${id}.json`,
    label: `${name} harness matrix passed`,
    subchecks: ["normal-completion", "permission-retry", "cancellation", "provider-failure", "recovery"],
  })),
  {
    id: "skills-google-workspace",
    file: "skills-google-workspace.json",
    label: "Dynamic bundled-skill and controlled Google Workspace matrix passed",
    subchecks: ["metadata", "loading", "prerequisites", "smoke-behavior", "permission-boundaries", "google-workspace-controlled-credentials"],
  },
  {
    id: "upgrade-rollback",
    file: "upgrade-rollback.json",
    label: "Backup, fresh-host restore, `0.1.0` upgrade, failed-upgrade simulation, and rollback passed",
    subchecks: ["backup-0.1.0-workspace", "fresh-host-restore", "candidate-upgrade", "persistent-state-verification", "failed-upgrade-simulation", "rollback"],
  },
  {
    id: "redaction-review",
    file: "redaction-review.json",
    label: "Sensitive-log and evidence-redaction review passed",
    subchecks: ["credentials-absent", "oauth-urls-absent", "customer-messages-absent", "phone-numbers-absent", "prompts-absent", "raw-sensitive-logs-absent"],
  },
  {
    id: "documentation-review",
    file: "documentation-review.json",
    label: "Documentation and final digest-consistency review passed",
    subchecks: [
      "retention", "sensitive-log-collection-redaction", "support-no-sla", "webhook-exposure", "vex-policy",
      "backup-timing", "restore", "upgrade", "rollback", "0.1.0-supersession", "digest-consistency",
      "acceptance-required-reviewers", "acceptance-prevent-self-review", "acceptance-bypass-disabled", "acceptance-main-only",
      "release-required-reviewers", "release-prevent-self-review", "release-bypass-disabled", "release-main-only",
    ],
  },
]);

export const MANUAL_ACCEPTANCE_MANIFEST = "acceptance-manifest.json";
export const MANUAL_ACCEPTANCE_MARKDOWN = "manual-acceptance.md";

const PLACEHOLDER_PATTERN = /\b(?:TBD|PENDING)\b/i;
const MANIFEST_KEYS = [
  "schemaVersion", "type", "version", "candidateRunId", "candidateCommit",
  "imageDigest", "acceptanceRunId", "attestedBy", "attestedAt", "files",
];
const CHECK_KEYS = [
  "schemaVersion", "type", "checkId", "status", "version", "candidateRunId",
  "candidateCommit", "imageDigest", "acceptanceRunId", "attestedBy", "attestedAt", "results",
];

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(sortedKeys(value), [...expected].sort())) {
    throw new Error(`${label} must use the fixed sanitized schema`);
  }
}

function validateBindings(input, includeAttestation = false) {
  for (const field of ["version", "candidateRunId", "candidateCommit", "imageDigest", "acceptanceRunId"]) {
    if (!input[field]) throw new Error(`${field} is required`);
    if (PLACEHOLDER_PATTERN.test(String(input[field]))) throw new Error(`${field} must not contain a placeholder`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error("version must be a semantic version without a v prefix");
  if (!/^\d+$/.test(input.candidateRunId)) throw new Error("candidate run ID must be numeric");
  if (!/^[0-9a-f]{40}$/.test(input.candidateCommit)) throw new Error("candidate commit must be a full SHA-1");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) throw new Error("image digest must be sha256:<64 lowercase hex characters>");
  if (!/^\d+$/.test(input.acceptanceRunId)) throw new Error("acceptance run ID must be numeric");
  if (includeAttestation) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.attestedBy ?? "")) {
      throw new Error("attestedBy must be a GitHub login");
    }
    const attestedAt = new Date(input.attestedAt ?? "");
    if (Number.isNaN(attestedAt.valueOf()) || attestedAt.toISOString() !== input.attestedAt) {
      throw new Error("attestedAt must be a canonical ISO-8601 UTC timestamp");
    }
  }
}

function checkRecord(input, check) {
  return {
    schemaVersion: 1,
    type: "felix.manual-acceptance-check",
    checkId: check.id,
    status: "passed",
    version: input.version,
    candidateRunId: input.candidateRunId,
    candidateCommit: input.candidateCommit,
    imageDigest: input.imageDigest,
    acceptanceRunId: input.acceptanceRunId,
    attestedBy: input.attestedBy,
    attestedAt: input.attestedAt,
    results: check.subchecks.map((id) => ({ id, status: "passed" })),
  };
}

function renderManual(input, manifestHash, fileHashes) {
  return [
    `# Felix ${input.version} release evidence`,
    "",
    MANUAL_POLICY_NOTE,
    "",
    `- Candidate run ID: ${input.candidateRunId}`,
    `- Acceptance run ID: ${input.acceptanceRunId}`,
    `- Candidate commit: ${input.candidateCommit}`,
    `- Candidate digest: ${input.imageDigest}`,
    `- Acceptance evidence manifest: artifact:${MANUAL_ACCEPTANCE_MANIFEST}@sha256:${manifestHash}`,
    ...MANUAL_ACCEPTANCE_CHECKS.map((check) => (
      `- [x] ${check.label}: artifact:${check.file}@sha256:${fileHashes[check.file]}`
    )),
    "",
  ].join("\n");
}

export async function generateManualReleaseEvidence(input) {
  if (!input.outputDir) throw new Error("outputDir is required");
  validateBindings(input, true);

  const fileHashes = {};
  for (const check of MANUAL_ACCEPTANCE_CHECKS) {
    const content = `${JSON.stringify(checkRecord(input, check), null, 2)}\n`;
    writeFileAtomic(path.join(input.outputDir, check.file), content, 0o600);
    fileHashes[check.file] = sha256(content);
  }

  const manifest = {
    schemaVersion: 1,
    type: "felix.manual-acceptance-manifest",
    version: input.version,
    candidateRunId: input.candidateRunId,
    candidateCommit: input.candidateCommit,
    imageDigest: input.imageDigest,
    acceptanceRunId: input.acceptanceRunId,
    attestedBy: input.attestedBy,
    attestedAt: input.attestedAt,
    files: fileHashes,
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileAtomic(path.join(input.outputDir, MANUAL_ACCEPTANCE_MANIFEST), manifestContent, 0o600);
  writeFileAtomic(
    path.join(input.outputDir, MANUAL_ACCEPTANCE_MARKDOWN),
    renderManual(input, sha256(manifestContent), fileHashes),
    0o600,
  );
  await verifyManualReleaseEvidence({ ...input, evidenceDir: input.outputDir });
}

export async function verifyManualReleaseEvidence(input) {
  if (!input.evidenceDir) throw new Error("evidenceDir is required");
  validateBindings(input);
  const expectedNames = [
    MANUAL_ACCEPTANCE_MANIFEST,
    MANUAL_ACCEPTANCE_MARKDOWN,
    ...MANUAL_ACCEPTANCE_CHECKS.map(({ file }) => file),
  ].sort();
  const entries = await readdir(input.evidenceDir, { withFileTypes: true });
  const actualNames = entries.map(({ name }) => name).sort();
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  const invalidContents = input.allowAdditionalFiles
    ? expectedNames.some((name) => !entriesByName.get(name)?.isFile())
    : !isDeepStrictEqual(actualNames, expectedNames) || entries.some((entry) => !entry.isFile());
  if (invalidContents) {
    throw new Error("manual evidence bundle must contain exactly the fixed sanitized files");
  }

  const manifestContent = await readFile(path.join(input.evidenceDir, MANUAL_ACCEPTANCE_MANIFEST));
  let manifest;
  try {
    manifest = JSON.parse(manifestContent.toString("utf8"));
  } catch {
    throw new Error("acceptance manifest must be valid JSON");
  }
  assertExactKeys(manifest, MANIFEST_KEYS, "acceptance manifest");
  validateBindings(manifest, true);
  for (const [field, label] of [
    ["version", "version"],
    ["candidateRunId", "candidate run ID"],
    ["candidateCommit", "candidate commit"],
    ["imageDigest", "image digest"],
    ["acceptanceRunId", "acceptance run ID"],
  ]) {
    if (manifest[field] !== input[field]) throw new Error(`${label} does not match`);
  }
  if (manifest.schemaVersion !== 1 || manifest.type !== "felix.manual-acceptance-manifest") {
    throw new Error("acceptance manifest must use the fixed sanitized schema");
  }
  assertExactKeys(manifest.files, MANUAL_ACCEPTANCE_CHECKS.map(({ file }) => file), "acceptance manifest files");

  const fileHashes = {};
  for (const check of MANUAL_ACCEPTANCE_CHECKS) {
    const content = await readFile(path.join(input.evidenceDir, check.file));
    const actualHash = sha256(content);
    if (manifest.files[check.file] !== actualHash) throw new Error(`${check.file} hash does not match acceptance manifest`);
    let record;
    try {
      record = JSON.parse(content.toString("utf8"));
    } catch {
      throw new Error(`${check.file} must be valid JSON`);
    }
    assertExactKeys(record, CHECK_KEYS, check.file);
    const expected = checkRecord(manifest, check);
    if (!isDeepStrictEqual(record, expected)) throw new Error(`${check.file} does not match the fixed candidate-bound record`);
    fileHashes[check.file] = actualHash;
  }

  const manual = await readFile(path.join(input.evidenceDir, MANUAL_ACCEPTANCE_MARKDOWN), "utf8");
  const expectedManual = renderManual(manifest, sha256(manifestContent), fileHashes);
  if (manual !== expectedManual) throw new Error("manual acceptance markdown does not match retained artifact bytes");
  if (PLACEHOLDER_PATTERN.test(manual)) throw new Error("manual acceptance markdown contains a placeholder");
}

function parseArgs(argv) {
  return Object.fromEntries([...parseNamedArgs(argv)].map(([name, value]) => [
    name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
    value,
  ]));
}

async function run() {
  const input = parseArgs(process.argv.slice(2));
  if (input.operation === "generate") return generateManualReleaseEvidence(input);
  if (input.operation === "verify") return verifyManualReleaseEvidence(input);
  throw new Error("--operation must be generate or verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
