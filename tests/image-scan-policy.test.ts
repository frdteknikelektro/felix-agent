import { describe, expect, it } from "vitest";
import { evaluateImageReport } from "../scripts/evaluate-image-scan.mjs";

const purl = "pkg:npm/example@1.0.0";

function report(vulnerability: Record<string, unknown>) {
  return {
    Results: [{
      Target: "node_modules",
      Type: "library",
      Vulnerabilities: [{
        VulnerabilityID: "CVE-2026-0001",
        PkgName: "example",
        PkgIdentifier: { PURL: purl },
        InstalledVersion: "1.0.0",
        Severity: "HIGH",
        ...vulnerability,
      }],
    }],
  };
}

function suppression(expiresAt = "2026-08-01T00:00:00Z") {
  return {
    vex: {
      statements: [{
        vulnerability: { name: "CVE-2026-0001" },
        products: [{ "@id": purl }],
        status: "not_affected",
        justification: "vulnerable_code_not_in_execute_path",
        impact_statement: "The package API containing the vulnerable code is never imported.",
      }],
    },
    review: {
      reviews: [{
        vulnerability: "CVE-2026-0001",
        product: purl,
        evidence: "tests/reachability/example.test.ts",
        reviewer: "security@example.com",
        reviewed_at: "2026-07-15T00:00:00Z",
        expires_at: expiresAt,
      }],
    },
  };
}

describe("candidate image risk policy", () => {
  const now = new Date("2026-07-16T00:00:00Z");

  it("blocks high and critical findings and records lower severities", () => {
    const high = evaluateImageReport(report({}), { statements: [] }, { reviews: [] }, now);
    const medium = evaluateImageReport(report({ Severity: "MEDIUM" }), { statements: [] }, { reviews: [] }, now);
    expect(high.blockers).toHaveLength(1);
    expect(medium.blockers).toHaveLength(0);
    expect(medium.recorded).toHaveLength(1);
  });

  it("accepts an exact, reviewed, unexpired not_affected statement", () => {
    const { vex, review } = suppression();
    const result = evaluateImageReport(report({}), vex, review, now);
    expect(result.blockers).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
  });

  it("rejects expired and unmatched VEX statements", () => {
    const expired = suppression("2026-07-15T00:00:00Z");
    expect(evaluateImageReport(report({}), expired.vex, expired.review, now).policyErrors).toContainEqual(
      expect.stringContaining("expired"),
    );

    const unmatched = suppression();
    unmatched.vex.statements[0].products[0]["@id"] = "pkg:npm/other@1.0.0";
    expect(evaluateImageReport(report({}), unmatched.vex, unmatched.review, now).policyErrors).toContainEqual(
      expect.stringContaining("unmatched"),
    );
  });

  it("rejects a suppression that does not identify a package PURL", () => {
    const missingProduct = report({ PkgIdentifier: undefined });
    const { vex, review } = suppression();
    vex.statements[0].products[0]["@id"] = "";
    review.reviews[0].product = "";
    const result = evaluateImageReport(missingProduct, vex, review, now);
    expect(result.policyErrors).toContainEqual(expect.stringContaining("missing product"));
    expect(result.blockers).toHaveLength(1);
  });

  it("never suppresses a fixable high finding", () => {
    const { vex, review } = suppression();
    const result = evaluateImageReport(report({ FixedVersion: "1.0.1" }), vex, review, now);
    expect(result.blockers).toContainEqual(expect.objectContaining({ reason: "fixable_critical_or_high" }));
  });

  it("blocks KEV findings unless exact reviewed VEX proves not affected", () => {
    const kevReport = report({ Severity: "MEDIUM", VendorSeverity: { "cisa-kev": 3 } });
    expect(evaluateImageReport(kevReport, { statements: [] }, { reviews: [] }, now).blockers).toHaveLength(1);
    const { vex, review } = suppression();
    expect(evaluateImageReport(kevReport, vex, review, now).blockers).toHaveLength(0);
  });

  it("promotes findings present only in the authoritative CISA catalog", () => {
    const medium = report({ Severity: "MEDIUM" });
    const catalog = { vulnerabilities: [{ cveID: "CVE-2026-0001" }] };
    const result = evaluateImageReport(medium, { statements: [] }, { reviews: [] }, now, catalog);
    expect(result.blockers).toContainEqual(expect.objectContaining({ reason: "cisa_kev" }));
  });

  it("blocks embedded secrets and high image misconfigurations", () => {
    const result = evaluateImageReport({
      Results: [{
        Target: "image",
        Secrets: [{ RuleID: "aws-access-key-id", Severity: "HIGH" }],
        Misconfigurations: [{ ID: "DS002", Severity: "HIGH", Status: "FAIL" }],
      }],
    }, { statements: [] }, { reviews: [] }, now);
    expect(result.blockers.map((item) => item.reason)).toEqual(["embedded_secret", "image_misconfiguration"]);
  });
});
