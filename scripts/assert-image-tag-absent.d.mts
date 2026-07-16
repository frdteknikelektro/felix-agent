export interface ImageInspectResult {
  reference: string;
  status: number | null;
  stdout?: string;
  stderr: string;
}

export function classifyImageLookup(
  result: ImageInspectResult,
): { state: "absent" } | { state: "present"; digest?: string };
export function classifyImageInspect(result: ImageInspectResult): "absent";
export function inspectImageTag(
  reference: string,
): { state: "absent" } | { state: "present"; digest?: string };
export function assertImageTagAbsent(reference: string): "absent";
