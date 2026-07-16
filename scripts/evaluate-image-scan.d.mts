export interface ImagePolicyResult {
  subject: { artifactName: string; artifactType: string };
  reportFingerprint: string;
  blockers: Array<Record<string, unknown>>;
  recorded: Array<Record<string, unknown>>;
  suppressed: Array<Record<string, unknown>>;
  policyErrors: string[];
}
export function policyReportFingerprint(report: Record<string, unknown>): string;
export function validateJsonSchema(value: unknown, schema: Record<string, unknown>, path?: string): string[];
export function validateOpenVexDocument(vex: unknown): string[];
export function evaluateImageReport(
  report: Record<string, unknown>,
  vex: Record<string, unknown>,
  review: Record<string, unknown>,
  now: Date,
  kevCatalog: { vulnerabilities: Array<{ cveID?: string }> },
  reviewSchema: Record<string, unknown>,
): ImagePolicyResult;
