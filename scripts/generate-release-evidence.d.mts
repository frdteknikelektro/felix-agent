export interface ReleaseEvidenceInput {
  version: string;
  candidateRunId: string;
  acceptanceRunId: string;
  candidateCommit: string;
  imageDigest: string;
  scan: string;
  sbom: string;
  provenance: string;
  manual: string;
  artifactDir: string;
  output: string;
}
export function generateReleaseEvidence(input: ReleaseEvidenceInput): Promise<void>;
