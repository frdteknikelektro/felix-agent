export interface ImagePolicyResult {
  blockers: Array<Record<string, unknown>>;
  recorded: Array<Record<string, unknown>>;
  suppressed: Array<Record<string, unknown>>;
  policyErrors: string[];
}
export function evaluateImageReport(
  report: Record<string, unknown>,
  vex: Record<string, unknown>,
  review: Record<string, unknown>,
  now?: Date,
  kevCatalog?: { vulnerabilities: Array<{ cveID?: string }> },
): ImagePolicyResult;
