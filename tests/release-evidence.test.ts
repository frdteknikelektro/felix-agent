import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateReleaseEvidence } from "../scripts/generate-release-evidence.mjs";
import {
  generateManualReleaseEvidence,
  MANUAL_ACCEPTANCE_CHECKS,
} from "../scripts/manual-release-evidence.mjs";

const runId = "123456";
const commit = "e".repeat(40);
const acceptanceRunId = "654321";
const requiredChecks = [
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
  "Backup, fresh-host restore, `0.1.0` upgrade, failed-upgrade simulation, and rollback passed",
  "Sensitive-log and evidence-redaction review passed",
  "Documentation and final digest-consistency review passed",
];

async function fixture(
  digest: string,
  transform: (manual: string) => string = (manual) => manual,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-evidence-"));
  const files = {
    artifactDir: dir,
    scan: path.join(dir, "scan.json"),
    sbom: path.join(dir, "sbom.spdx.json"),
    provenance: path.join(dir, "provenance.json"),
    manual: path.join(dir, "manual-acceptance.md"),
    output: path.join(dir, "evidence.md"),
    acceptanceRunId,
  };
  await generateManualReleaseEvidence({
    version: "0.1.1",
    candidateRunId: runId,
    candidateCommit: commit,
    imageDigest: digest,
    acceptanceRunId,
    attestedBy: "release-reviewer",
    attestedAt: "2026-07-16T12:34:56.000Z",
    outputDir: dir,
  });
  const sourceManual = await fs.readFile(files.manual, "utf8");
  await Promise.all([
    fs.writeFile(files.scan, '{"blockers":[],"policyErrors":[]}\n'),
    fs.writeFile(files.sbom, '{"spdxVersion":"SPDX-2.3"}\n'),
    fs.writeFile(files.provenance, '{"predicateType":"https://slsa.dev/provenance/v1"}\n'),
    fs.writeFile(files.manual, transform(sourceManual)),
  ]);
  return files;
}

describe("release evidence generation", () => {
  it("accepts a completed sanitized copy of the committed evidence template", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const template = await fs.readFile("docs/releases/0.1.1-evidence.md", "utf8");
    expect(template).toContain("fixed artifact names and SHA-256 references only");
    for (const check of requiredChecks) expect(template).toContain(`- [ ] ${check}: PENDING`);
    const files = await fixture(digest);
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).resolves.toBeUndefined();
  });

  it("binds completed evidence to the requested version and immutable digest", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest);
    await generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    });
    const output = await fs.readFile(files.output, "utf8");
    expect(output).toContain("Felix 0.1.1 release evidence");
    expect(output).toContain(digest);
    expect(output).toContain("## Release assets");
    expect(output).toContain("| scan.json |");
    expect(output).toContain("| sbom.spdx.json |");
    expect(output).toContain("| provenance.json |");
    expect(output).toContain("| manual-acceptance.md |");
    expect(output).not.toContain("TBD");
    expect((await fs.stat(files.output)).mode & 0o777).toBe(0o600);
  });

  it("rejects incomplete manual evidence and placeholder fields", async () => {
    const uncheckedDigest = `sha256:${"b".repeat(64)}`;
    const unchecked = await fixture(uncheckedDigest, (manual) => manual.replace("- [x]", "- [ ]"));
    await expect(generateReleaseEvidence({
      version: "0.1.1",
      candidateRunId: runId,
      candidateCommit: commit,
      imageDigest: uncheckedDigest,
      ...unchecked,
    })).rejects.toThrow(/manual acceptance markdown|incomplete/i);

    const placeholderDigest = `sha256:${"c".repeat(64)}`;
    const placeholder = await fixture(placeholderDigest, (manual) => manual.replace(/artifact:[^\s]+/, "result TBD"));
    await expect(generateReleaseEvidence({
      version: "0.1.1",
      candidateRunId: runId,
      candidateCommit: commit,
      imageDigest: placeholderDigest,
      ...placeholder,
    })).rejects.toThrow(/manual acceptance markdown|placeholder/);

    const pendingDigest = `sha256:${"d".repeat(64)}`;
    const pending = await fixture(pendingDigest, (manual) => manual.replace(/artifact:[^\s]+/, "result PENDING"));
    await expect(generateReleaseEvidence({
      version: "0.1.1",
      candidateRunId: runId,
      candidateCommit: commit,
      imageDigest: pendingDigest,
      ...pending,
    })).rejects.toThrow(/manual acceptance markdown|placeholder/);
  });

  it("requires an exact sha256 digest", async () => {
    const files = await fixture(`sha256:${"f".repeat(64)}`);
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: "latest", ...files,
    }))
      .rejects.toThrow(/digest/i);
  });

  it("requires the complete release artifact directory", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest);
    const { artifactDir: _artifactDir, ...withoutArtifactDir } = files;
    await expect(generateReleaseEvidence({
      version: "0.1.1",
      candidateRunId: runId,
      candidateCommit: commit,
      imageDigest: digest,
      ...withoutArtifactDir,
    } as any)).rejects.toThrow(/artifactDir is required/i);
  });

  it("rejects manual evidence bound to a different candidate", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest, (manual) => manual.replace(runId, "999999"));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/manual acceptance markdown|candidate run id does not match/i);
  });

  it("rejects truncated evidence that omits an acceptance check", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest, (manual) => manual.replace(/^.*Mattermost source matrix passed.*\n/m, ""));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/manual acceptance markdown|missing completed check: Mattermost/);
  });

  it("rejects a checked acceptance item without an evidence reference", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest, (manual) => manual.replace(
      /(- \[x\] Mattermost source matrix passed:).*$/m,
      "$1",
    ));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/manual acceptance markdown|missing completed check: Mattermost/);
  });

  it("rejects raw credentials in manual release evidence", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest, (manual) => manual.replace(
      /artifact:[^\s]+/,
      "OPENAI_API_KEY=sk-customer-secret-value",
    ));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/manual acceptance markdown|fixed sanitized artifact/i);
  });

  it("rejects customer messages or prompts added to manual release evidence", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest, (manual) => `${manual}Customer message: please deploy my private prompt\n`);
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/manual acceptance markdown|unexpected content/i);
  });

  it("rejects unsafe-but-grammar-valid evidence artifact names", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const unsafeReference = `artifact:customer-private-prompt.json@sha256:${"8".repeat(64)}`;
    const files = await fixture(digest, (manual) => manual.replace(/artifact:[^\s]+/, unsafeReference));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/manual acceptance markdown|fixed sanitized artifact/i);
  });

  it("rejects a reference whose digest does not match the retained file", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest, (manual) => manual.replace(
      /(@sha256:)[0-9a-f]{64}/,
      `$1${"0".repeat(64)}`,
    ));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/manual acceptance markdown|hash does not match/i);
  });

  it("rejects a reference after its retained file is removed", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(digest);
    await fs.unlink(path.join(files.artifactDir, MANUAL_ACCEPTANCE_CHECKS[0].file));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/fixed sanitized files|referenced artifact does not exist/i);
  });
});
