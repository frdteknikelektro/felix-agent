import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateManualReleaseEvidence,
  MANUAL_ACCEPTANCE_CHECKS,
  verifyManualReleaseEvidence,
} from "../scripts/manual-release-evidence.mjs";

const input = {
  version: "0.1.1",
  candidateRunId: "123456",
  candidateCommit: "e".repeat(40),
  imageDigest: `sha256:${"a".repeat(64)}`,
  acceptanceRunId: "654321",
  attestedBy: "release-reviewer",
  attestedAt: "2026-07-16T12:34:56.000Z",
};

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "felix-manual-evidence-"));
  await generateManualReleaseEvidence({ ...input, outputDir: directory });
  return directory;
}

describe("manual release evidence", () => {
  it("generates and verifies a fixed-name, candidate-bound sanitized bundle", async () => {
    const directory = await fixture();
    await expect(verifyManualReleaseEvidence({ ...input, evidenceDir: directory })).resolves.toBeUndefined();
    expect((await fs.readdir(directory)).sort()).toEqual([
      "acceptance-manifest.json",
      "manual-acceptance.md",
      ...MANUAL_ACCEPTANCE_CHECKS.map(({ file }) => file),
    ].sort());
    for (const check of MANUAL_ACCEPTANCE_CHECKS) {
      const record = JSON.parse(await fs.readFile(path.join(directory, check.file), "utf8"));
      expect(record.results).toEqual(check.subchecks.map((id) => ({ id, status: "passed" })));
    }
    expect(MANUAL_ACCEPTANCE_CHECKS.find(({ id }) => id === "runtime-lifecycle")?.subchecks).toEqual(expect.arrayContaining([
      "clean-setup-env-creation", "config-env-mode-0600",
    ]));
    expect(MANUAL_ACCEPTANCE_CHECKS.find(({ id }) => id === "whatsapp")?.subchecks).toEqual(expect.arrayContaining([
      "webhook-authentication-disabled", "webhook-authentication-reconnecting",
    ]));
    expect(MANUAL_ACCEPTANCE_CHECKS.find(({ id }) => id === "telegram")?.subchecks).toEqual(expect.arrayContaining([
      "polling-mode", "authenticated-webhook-mode",
    ]));
  });

  it("rejects a missing referenced artifact", async () => {
    const directory = await fixture();
    await fs.unlink(path.join(directory, MANUAL_ACCEPTANCE_CHECKS[0].file));
    await expect(verifyManualReleaseEvidence({ ...input, evidenceDir: directory })).rejects.toThrow(/exactly the fixed sanitized files/i);
  });

  it("rejects a byte-hash mismatch", async () => {
    const directory = await fixture();
    await fs.appendFile(path.join(directory, MANUAL_ACCEPTANCE_CHECKS[0].file), "forged\n");
    await expect(verifyManualReleaseEvidence({ ...input, evidenceDir: directory })).rejects.toThrow(/hash does not match/i);
  });

  it("rejects a record with an omitted required subcheck", async () => {
    const directory = await fixture();
    const check = MANUAL_ACCEPTANCE_CHECKS[0];
    const file = path.join(directory, check.file);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.results.pop();
    const recordContent = `${JSON.stringify(record, null, 2)}\n`;
    await fs.writeFile(file, recordContent);

    const manifestPath = path.join(directory, "acceptance-manifest.json");
    const originalManifestContent = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifestContent);
    const originalRecordHash = manifest.files[check.file];
    manifest.files[check.file] = sha256(recordContent);
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(manifestPath, manifestContent);

    const manualPath = path.join(directory, "manual-acceptance.md");
    const manual = (await fs.readFile(manualPath, "utf8"))
      .replace(`sha256:${sha256(originalManifestContent)}`, `sha256:${sha256(manifestContent)}`)
      .replace(`sha256:${originalRecordHash}`, `sha256:${manifest.files[check.file]}`);
    await fs.writeFile(manualPath, manual);
    await expect(verifyManualReleaseEvidence({ ...input, evidenceDir: directory })).rejects.toThrow(/fixed candidate-bound record/i);
  });

  it("rejects extra or unsafe-but-grammar-valid artifact names", async () => {
    const directory = await fixture();
    await fs.writeFile(path.join(directory, "customer-private-prompt.json"), "{}\n");
    await expect(verifyManualReleaseEvidence({ ...input, evidenceDir: directory })).rejects.toThrow(/exactly the fixed sanitized files/i);
  });

  it("rejects evidence bound to another acceptance run", async () => {
    const directory = await fixture();
    await expect(verifyManualReleaseEvidence({
      ...input,
      acceptanceRunId: "999999",
      evidenceDir: directory,
    })).rejects.toThrow(/acceptance run id does not match/i);
  });
});
