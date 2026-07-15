export interface ReleaseEvidenceInput {
  version: string;
  candidateRunId: string;
  candidateCommit: string;
  imageDigest: string;
  scan: string;
  sbom: string;
  provenance: string;
  manual: string;
  output: string;
}
export function generateReleaseEvidence(input: ReleaseEvidenceInput): Promise<void>;
