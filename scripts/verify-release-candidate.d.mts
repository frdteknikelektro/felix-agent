export interface CandidateManifest {
  runId: string;
  version: string;
  digest: string;
  commit: string;
  image: string;
  platforms: Record<"linux/amd64" | "linux/arm64", string>;
}
export function verifyCandidate(manifest: CandidateManifest, expected: CandidateManifest): CandidateManifest;
export function verifyRegistryManifest(
  manifest: CandidateManifest,
  registryManifest: any,
): { amd64Digest: string; arm64Digest: string };
export function verifyReleaseEvidence(
  manifest: CandidateManifest,
  evidence: { policy: any; scan: any; sbomManifest: any },
): { amd64Digest: string; arm64Digest: string };
