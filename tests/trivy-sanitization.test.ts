import { describe, expect, it } from "vitest";
import { sanitizeTrivyReport, selectTrivyFindings } from "../scripts/sanitize-trivy-report.mjs";

describe("Trivy evidence sanitization", () => {
  it("retains policy metadata while removing matched secrets and source excerpts", () => {
    const rawSecret = "ghp_raw-secret-value";
    const report = {
      SchemaVersion: 2,
      Metadata: {
        OS: { Family: "debian", Name: "12" },
        ImageID: "sha256:image",
        RepoURL: "git@example.invalid:private/repository.git",
        Author: "Private Person <person@example.invalid>",
        Committer: "Private Person <person@example.invalid>",
      },
      Results: [{
        Target: "/app/config.json",
        Secrets: [{
          RuleID: "github-pat",
          Category: "GitHub",
          Severity: "HIGH",
          Title: "GitHub Personal Access Token",
          StartLine: 2,
          EndLine: 2,
          Match: rawSecret,
          Code: { Lines: [{ Number: 2, Content: `token=${rawSecret}`, IsCause: true }] },
        }],
        Misconfigurations: [{
          ID: "DS001",
          Severity: "HIGH",
          Status: "FAIL",
          CauseMetadata: { Code: { Lines: [{ Content: `password=${rawSecret}` }] } },
        }],
      }],
    };

    const sanitized = sanitizeTrivyReport(report);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain("Match");
    expect(serialized).not.toContain("CauseMetadata");
    expect(serialized).not.toContain("person@example.invalid");
    expect(serialized).not.toContain("private/repository.git");
    expect(sanitized.Metadata).toEqual({ OS: { Family: "debian", Name: "12" }, ImageID: "sha256:image" });
    expect(sanitized.Results[0].Secrets[0]).toMatchObject({
      RuleID: "github-pat",
      Severity: "HIGH",
      StartLine: 2,
    });
    expect(sanitized.Results[0].Misconfigurations[0]).toMatchObject({ ID: "DS001", Status: "FAIL" });
    expect(selectTrivyFindings(sanitized, "Misconfigurations").Results).toEqual([{
      Target: "/app/config.json",
      Misconfigurations: [expect.objectContaining({ ID: "DS001", Status: "FAIL" })],
    }]);
  });
});
