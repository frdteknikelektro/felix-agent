import { describe, expect, it } from "vitest";
import { evaluateImageReport } from "../scripts/evaluate-image-scan.mjs";
import {
  verifyCandidate,
  verifyRegistryManifest,
  verifyReleaseEvidence,
} from "../scripts/verify-release-candidate.mjs";

const digest = `sha256:${"d".repeat(64)}`;
const amd64Digest = `sha256:${"a".repeat(64)}`;
const arm64Digest = `sha256:${"b".repeat(64)}`;
const commit = "1".repeat(40);
const image = "frdinawan/felix-agent";
const manifest = {
  runId: "12345",
  version: "0.1.1",
  digest,
  commit,
  image,
  platforms: {
    "linux/amd64": amd64Digest,
    "linux/arm64": arm64Digest,
  },
};

describe("candidate-to-release binding", () => {
  it("accepts only the exact run, version, commit, image, digest, and platform digests", () => {
    expect(verifyCandidate(manifest, manifest)).toEqual(manifest);
  });

  it.each([
    ["runId", "999"],
    ["version", "0.1.0"],
    ["commit", "2".repeat(40)],
    ["digest", `sha256:${"e".repeat(64)}`],
    ["image", "other/felix-agent"],
  ] as const)("rejects a mismatched %s", (field, value) => {
    expect(() => verifyCandidate(manifest, { ...manifest, [field]: value })).toThrow(new RegExp(field, "i"));
  });

  it("rejects mutable or malformed identifiers", () => {
    expect(() => verifyCandidate({ ...manifest, digest: "latest" }, manifest)).toThrow(/digest/i);
    expect(() => verifyCandidate({ ...manifest, commit: "main" }, manifest)).toThrow(/commit/i);
    expect(() => verifyCandidate({
      ...manifest,
      platforms: { ...manifest.platforms, "linux/arm64": "latest" },
    }, manifest)).toThrow(/linux\/arm64/i);
  });

  it("binds the policy, sanitized scan, and SBOM manifest to the candidate", () => {
    const scan = {
      ArtifactName: `${image}@${digest}`,
      ArtifactType: "multiarch-container-image",
      Results: [{
        Target: "linux/amd64:node_modules",
        Vulnerabilities: [{
          VulnerabilityID: "CVE-2026-0001",
          PkgName: "example",
          PkgIdentifier: { PURL: "pkg:npm/example@1.0.0" },
          InstalledVersion: "1.0.0",
          Severity: "MEDIUM",
        }],
      }],
    };
    const policy = evaluateImageReport(scan, { statements: [] }, { reviews: [] });
    const sbomManifest = {
      schemaVersion: 1,
      imageDigest: digest,
      platforms: [
        {
          platform: "linux/amd64",
          digest: amd64Digest,
          spdx: "sbom-amd64.spdx.json",
          cyclonedx: "sbom-amd64.cyclonedx.json",
        },
        {
          platform: "linux/arm64",
          digest: arm64Digest,
          spdx: "sbom-arm64.spdx.json",
          cyclonedx: "sbom-arm64.cyclonedx.json",
        },
      ],
    };

    expect(verifyReleaseEvidence(manifest, { policy, scan, sbomManifest })).toEqual({
      amd64Digest,
      arm64Digest,
    });
    expect(() => verifyReleaseEvidence(manifest, {
      policy,
      scan: { ...scan, ArtifactName: `${image}@sha256:${"e".repeat(64)}` },
      sbomManifest,
    })).toThrow(/scan.*candidate/i);
    expect(() => verifyReleaseEvidence(manifest, {
      policy,
      scan,
      sbomManifest: { ...sbomManifest, imageDigest: `sha256:${"e".repeat(64)}` },
    })).toThrow(/SBOM.*digest/i);
  });

  it("binds the live registry index platform digests to the candidate", () => {
    const registryManifest = {
      schemaVersion: 2,
      manifests: [
        { digest: amd64Digest, platform: { os: "linux", architecture: "amd64" } },
        { digest: arm64Digest, platform: { os: "linux", architecture: "arm64" } },
        { digest: `sha256:${"c".repeat(64)}`, platform: { os: "unknown", architecture: "unknown" } },
      ],
    };
    expect(verifyRegistryManifest(manifest, registryManifest)).toEqual({
      amd64Digest,
      arm64Digest,
    });
    expect(() => verifyRegistryManifest(manifest, {
      ...registryManifest,
      manifests: registryManifest.manifests.map((entry) => (
        entry.platform.architecture === "arm64"
          ? { ...entry, digest: `sha256:${"e".repeat(64)}` }
          : entry
      )),
    })).toThrow(/linux\/arm64.*digest/i);
  });
});
