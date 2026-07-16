import { describe, expect, it } from "vitest";
import { mergeSarifReports } from "../scripts/merge-sarif.mjs";

function sarif(resultId: string) {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "Trivy" } },
      results: [{ ruleId: resultId }],
    }],
  };
}

describe("multi-platform SARIF evidence", () => {
  it("assigns a distinct GitHub code-scanning category to every platform run", () => {
    const merged = mergeSarifReports([
      { category: "trivy/linux-amd64", report: sarif("AMD64") },
      { category: "trivy/linux-arm64", report: sarif("ARM64") },
    ]);

    expect(merged.runs).toHaveLength(2);
    expect(merged.runs.map((run) => run.automationDetails?.id)).toEqual([
      "trivy/linux-amd64/",
      "trivy/linux-arm64/",
    ]);
    expect(new Set(merged.runs.map((run) => run.automationDetails?.id)).size).toBe(2);
  });

  it("rejects duplicate categories before GitHub rejects the upload", () => {
    expect(() => mergeSarifReports([
      { category: "trivy/linux-amd64", report: sarif("one") },
      { category: "trivy/linux-amd64", report: sarif("two") },
    ])).toThrow(/duplicate SARIF category/i);
  });
});
