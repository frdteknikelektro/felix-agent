export interface ImageInspectResult {
  reference: string;
  status: number | null;
  stderr: string;
}

export function classifyImageInspect(result: ImageInspectResult): "absent";
export function assertImageTagAbsent(reference: string): "absent";
