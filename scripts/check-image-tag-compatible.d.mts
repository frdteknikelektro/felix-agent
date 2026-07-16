export interface CompatibleImageInspectResult {
  reference: string;
  expectedDigest: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function classifyCompatibleImageInspect(result: CompatibleImageInspectResult): "absent" | "present";
export function checkImageTagCompatible(reference: string, expectedDigest: string): "absent" | "present";
