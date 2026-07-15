export interface CandidateManifest { runId: string; version: string; digest: string; commit: string }
export function verifyCandidate(manifest: CandidateManifest, expected: CandidateManifest): CandidateManifest;
