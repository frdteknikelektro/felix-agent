import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateReleaseEvidence } from "../scripts/generate-release-evidence.mjs";

const runId = "123456";
const commit = "e".repeat(40);
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

function completedManual(digest: string, result = "accepted") {
  return [
    "# Felix 0.1.1 release evidence",
    "",
    `- Candidate run ID: ${runId}`,
    `- Candidate commit: ${commit}`,
    `- Candidate digest: ${digest}`,
    ...requiredChecks.map((check) => `- [x] ${check}: ${result}`),
    "",
  ].join("\n");
}

async function fixture(manual: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-evidence-"));
  const files = {
    artifactDir: dir,
    scan: path.join(dir, "scan.json"),
    sbom: path.join(dir, "sbom.spdx.json"),
    provenance: path.join(dir, "provenance.json"),
    manual: path.join(dir, "manual.md"),
    output: path.join(dir, "evidence.md"),
  };
  await Promise.all([
    fs.writeFile(files.scan, '{"blockers":[],"policyErrors":[]}\n'),
    fs.writeFile(files.sbom, '{"spdxVersion":"SPDX-2.3"}\n'),
    fs.writeFile(files.provenance, '{"predicateType":"https://slsa.dev/provenance/v1"}\n'),
    fs.writeFile(files.manual, manual),
  ]);
  return files;
}

describe("release evidence generation", () => {
  it("binds completed evidence to the requested version and immutable digest", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(completedManual(digest));
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
    expect(output).toContain("| manual.md |");
    expect(output).not.toContain("TBD");
    expect((await fs.stat(files.output)).mode & 0o777).toBe(0o600);
  });

  it("rejects incomplete manual evidence and placeholder fields", async () => {
    const uncheckedDigest = `sha256:${"b".repeat(64)}`;
    const unchecked = await fixture(completedManual(uncheckedDigest).replace("- [x]", "- [ ]"));
    await expect(generateReleaseEvidence({
      version: "0.1.1",
      candidateRunId: runId,
      candidateCommit: commit,
      imageDigest: uncheckedDigest,
      ...unchecked,
    })).rejects.toThrow(/incomplete/i);

    const placeholderDigest = `sha256:${"c".repeat(64)}`;
    const placeholder = await fixture(completedManual(placeholderDigest, "result TBD"));
    await expect(generateReleaseEvidence({
      version: "0.1.1",
      candidateRunId: runId,
      candidateCommit: commit,
      imageDigest: placeholderDigest,
      ...placeholder,
    })).rejects.toThrow(/placeholder/);

    const pendingDigest = `sha256:${"d".repeat(64)}`;
    const pending = await fixture(completedManual(pendingDigest, "result PENDING"));
    await expect(generateReleaseEvidence({
      version: "0.1.1",
      candidateRunId: runId,
      candidateCommit: commit,
      imageDigest: pendingDigest,
      ...pending,
    })).rejects.toThrow(/placeholder/);
  });

  it("requires an exact sha256 digest", async () => {
    const files = await fixture(completedManual(`sha256:${"f".repeat(64)}`));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: "latest", ...files,
    }))
      .rejects.toThrow(/digest/i);
  });

  it("requires the complete release artifact directory", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(completedManual(digest));
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
    const files = await fixture(completedManual(digest).replace(runId, "999999"));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/run id does not match/i);
  });

  it("rejects truncated evidence that omits an acceptance check", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(completedManual(digest).replace(/^.*Mattermost source matrix passed.*\n/m, ""));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/missing completed check: Mattermost/);
  });

  it("rejects a checked acceptance item without an evidence reference", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const files = await fixture(completedManual(digest).replace(
      /(- \[x\] Mattermost source matrix passed:).*$/m,
      "$1",
    ));
    await expect(generateReleaseEvidence({
      version: "0.1.1", candidateRunId: runId, candidateCommit: commit, imageDigest: digest, ...files,
    })).rejects.toThrow(/missing completed check: Mattermost/);
  });
});
