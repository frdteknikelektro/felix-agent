#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseNamedArgs, requireNamedArgs } from "./cli-args.mjs";
import { policyReportFingerprint } from "./evaluate-image-scan.mjs";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PLATFORM_FILES = {
  "linux/amd64": {
    spdx: "sbom-amd64.spdx.json",
    cyclonedx: "sbom-amd64.cyclonedx.json",
  },
  "linux/arm64": {
    spdx: "sbom-arm64.spdx.json",
    cyclonedx: "sbom-arm64.cyclonedx.json",
  },
};
const RUNTIME_SMOKE_CHECKS = [
  "health",
  "login",
  "unauthenticated_api",
  "unauthenticated_sse",
  "disabled_sources",
  "read_only_rootfs",
  "restart_persistence",
  "graceful_shutdown",
  "crash_restart",
];

export function verifyCandidate(manifest, expected) {
  if (!/^\d+$/.test(String(manifest.runId))) throw new Error("candidate runId must be numeric");
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) throw new Error("candidate version is invalid");
  if (!/^[0-9a-f]{40}$/.test(String(manifest.commit))) throw new Error("candidate commit must be a full SHA-1");
  if (!DIGEST_PATTERN.test(String(manifest.digest))) throw new Error("candidate digest is invalid");
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(String(manifest.image))) {
    throw new Error("candidate image is invalid");
  }
  for (const field of ["runId", "version", "commit", "digest", "image"]) {
    if (String(manifest[field]) !== String(expected[field])) throw new Error(`candidate ${field} does not match`);
  }
  for (const platform of Object.keys(PLATFORM_FILES)) {
    if (!DIGEST_PATTERN.test(String(manifest.platforms?.[platform]))) {
      throw new Error(`candidate ${platform} digest is invalid`);
    }
    if (expected.platforms?.[platform]
      && String(manifest.platforms[platform]) !== String(expected.platforms[platform])) {
      throw new Error(`candidate ${platform} digest does not match`);
    }
  }
  if (Object.keys(manifest.platforms ?? {}).sort().join(",") !== Object.keys(PLATFORM_FILES).sort().join(",")) {
    throw new Error("candidate platforms must contain exactly linux/amd64 and linux/arm64");
  }
  return manifest;
}

/** Prove the live registry index still contains the candidate's exact platform manifests. */
export function verifyRegistryManifest(manifest, registryManifest) {
  if (registryManifest?.schemaVersion !== 2 || !Array.isArray(registryManifest.manifests)) {
    throw new Error("registry manifest is not a valid image index");
  }
  const verified = {};
  for (const platform of Object.keys(PLATFORM_FILES)) {
    const [os, architecture] = platform.split("/");
    const matches = registryManifest.manifests.filter((entry) => (
      entry?.platform?.os === os && entry?.platform?.architecture === architecture
    ));
    if (matches.length !== 1) {
      throw new Error(`registry manifest must contain exactly one ${platform} image`);
    }
    if (matches[0].digest !== manifest.platforms[platform]) {
      throw new Error(`registry ${platform} digest does not match candidate`);
    }
    verified[architecture] = matches[0].digest;
  }
  return {
    amd64Digest: verified.amd64,
    arm64Digest: verified.arm64,
  };
}

/** Bind successful, exact-digest runtime acceptance to both supported architectures. */
export function verifyRuntimeSmoke(manifest, reports) {
  if (!Array.isArray(reports) || reports.length !== Object.keys(PLATFORM_FILES).length) {
    throw new Error("runtime smoke evidence must contain exactly two platform reports");
  }
  const byPlatform = new Map(reports.map((report) => [report?.platform, report]));
  if (byPlatform.size !== Object.keys(PLATFORM_FILES).length) {
    throw new Error("runtime smoke evidence contains duplicate platforms");
  }
  const image = `${manifest.image}@${manifest.digest}`;
  for (const platform of Object.keys(PLATFORM_FILES)) {
    const report = byPlatform.get(platform);
    if (!report || report.schemaVersion !== 1) {
      throw new Error(`runtime smoke ${platform} report is missing or invalid`);
    }
    if (report.image !== image) {
      throw new Error(`runtime smoke ${platform} is not bound to the candidate image`);
    }
    if (!Array.isArray(report.checks)) {
      throw new Error(`runtime smoke ${platform} checks are missing`);
    }
    const checks = new Map(report.checks.map((check) => [check?.name, check]));
    if (report.checks.length !== RUNTIME_SMOKE_CHECKS.length
      || checks.size !== RUNTIME_SMOKE_CHECKS.length) {
      throw new Error(`runtime smoke ${platform} must contain the complete check set`);
    }
    for (const name of RUNTIME_SMOKE_CHECKS) {
      if (checks.get(name)?.passed !== true) {
        throw new Error(`runtime smoke ${platform} check failed: ${name}`);
      }
    }
  }
  return { platforms: Object.keys(PLATFORM_FILES) };
}

export function verifyReleaseEvidence(manifest, { policy, scan, sbomManifest }) {
  verifyCandidate(manifest, manifest);
  const artifactName = `${manifest.image}@${manifest.digest}`;
  if (scan.ArtifactName !== artifactName || scan.ArtifactType !== "multiarch-container-image") {
    throw new Error("sanitized scan is not bound to the candidate image");
  }
  if (policy.subject?.artifactName !== artifactName
    || policy.subject?.artifactType !== "multiarch-container-image") {
    throw new Error("scan policy is not bound to the candidate image");
  }
  if (policy.reportFingerprint !== policyReportFingerprint(scan)) {
    throw new Error("scan policy fingerprint does not match sanitized scan evidence");
  }
  if (!Array.isArray(policy.blockers) || !Array.isArray(policy.policyErrors)) {
    throw new Error("scan policy result is incomplete");
  }
  if (sbomManifest.schemaVersion !== 1 || sbomManifest.imageDigest !== manifest.digest) {
    throw new Error("SBOM manifest digest does not match candidate digest");
  }
  const platformEntries = sbomManifest.platforms ?? [];
  if (!Array.isArray(platformEntries)) {
    throw new Error("SBOM manifest platforms must be an array");
  }
  const platforms = new Map(platformEntries.map((entry) => [entry.platform, entry]));
  if (platformEntries.length !== Object.keys(PLATFORM_FILES).length
    || platforms.size !== Object.keys(PLATFORM_FILES).length) {
    throw new Error("SBOM manifest must contain exactly two supported platforms");
  }
  for (const [platform, files] of Object.entries(PLATFORM_FILES)) {
    const entry = platforms.get(platform);
    if (!entry || entry.digest !== manifest.platforms[platform]) {
      throw new Error(`SBOM manifest ${platform} digest does not match candidate`);
    }
    if (entry.spdx !== files.spdx || entry.cyclonedx !== files.cyclonedx) {
      throw new Error(`SBOM manifest ${platform} artifact names are invalid`);
    }
  }
  return {
    amd64Digest: manifest.platforms["linux/amd64"],
    arm64Digest: manifest.platforms["linux/arm64"],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = requireNamedArgs(
      parseNamedArgs(process.argv.slice(2)),
      [
        "manifest",
        "run-id",
        "version",
        "commit",
        "digest",
        "image",
        "evidence-dir",
        "registry-manifest",
        "runtime-smoke-amd64",
        "runtime-smoke-arm64",
      ],
    );
    const manifest = JSON.parse(readFileSync(args.get("manifest"), "utf8"));
    verifyCandidate(manifest, {
      ...manifest,
      runId: args.get("run-id"),
      version: args.get("version"),
      commit: args.get("commit"),
      digest: args.get("digest"),
      image: args.get("image"),
    });
    const evidenceDir = args.get("evidence-dir");
    verifyRegistryManifest(
      manifest,
      JSON.parse(readFileSync(args.get("registry-manifest"), "utf8")),
    );
    verifyRuntimeSmoke(manifest, [
      JSON.parse(readFileSync(args.get("runtime-smoke-amd64"), "utf8")),
      JSON.parse(readFileSync(args.get("runtime-smoke-arm64"), "utf8")),
    ]);
    verifyReleaseEvidence(manifest, {
      policy: JSON.parse(readFileSync(path.join(evidenceDir, "policy-result.json"), "utf8")),
      scan: JSON.parse(readFileSync(path.join(evidenceDir, "trivy-full.json"), "utf8")),
      sbomManifest: JSON.parse(readFileSync(path.join(evidenceDir, "sbom-manifest.json"), "utf8")),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
