export interface SarifRun {
  automationDetails?: {
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SarifReport {
  runs: SarifRun[];
  [key: string]: unknown;
}

export function mergeSarifReports(entries: Array<{
  category: string;
  report: SarifReport;
}>): SarifReport;
