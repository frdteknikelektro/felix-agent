export interface ManualAcceptanceCheck {
  id: string;
  file: string;
  label: string;
  subchecks: string[];
}

export interface ManualReleaseEvidenceBindings {
  version: string;
  candidateRunId: string;
  candidateCommit: string;
  imageDigest: string;
  acceptanceRunId: string;
}

export interface GenerateManualReleaseEvidenceInput extends ManualReleaseEvidenceBindings {
  attestedBy: string;
  attestedAt: string;
  outputDir: string;
}

export interface VerifyManualReleaseEvidenceInput extends ManualReleaseEvidenceBindings {
  evidenceDir: string;
  allowAdditionalFiles?: boolean;
}

export const MANUAL_POLICY_NOTE: string;
export const MANUAL_ACCEPTANCE_CHECKS: readonly ManualAcceptanceCheck[];
export const MANUAL_ACCEPTANCE_MANIFEST: string;
export const MANUAL_ACCEPTANCE_MARKDOWN: string;
export function generateManualReleaseEvidence(input: GenerateManualReleaseEvidenceInput): Promise<void>;
export function verifyManualReleaseEvidence(input: VerifyManualReleaseEvidenceInput): Promise<void>;
