export function isSecretKey(key: string): boolean;
export function displayEnvValue(key: string, value: unknown): string;
export function maskSecretInput(value: unknown, state?: { isFinal?: boolean }): string;
export function withoutLegacyOwnerPresentation(
  existing: Record<string, string>,
): Record<string, string>;
export function writeFileAtomic(file: string, content: string, mode?: number): void;
export function parseSetupTemplate(file: string): Array<{
  type: "blank" | "comment" | "optional" | "setting";
  raw: string;
  key?: string;
  value?: string;
}>;
export function writeSetupEnv(
  templatePath: string,
  outputPath: string,
  answers: Record<string, string>,
  existing?: Record<string, string>,
): void;
