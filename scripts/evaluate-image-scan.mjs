#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "./setup-support.mjs";

function key(vulnerability, product) {
  return `${vulnerability}\u0000${product}`;
}

function isKev(finding) {
  const vendor = finding.VendorSeverity ?? {};
  return Object.keys(vendor).some((name) => name.toLowerCase().replace(/_/g, "-").includes("cisa-kev"))
    || String(finding.DataSource?.ID ?? "").toLowerCase().includes("cisa-kev")
    || (finding.References ?? []).some((url) => String(url).includes("cisa.gov/known-exploited"));
}

function vulnerabilityRecord(target, finding, kevIds) {
  return {
    kind: "vulnerability",
    target,
    vulnerability: finding.VulnerabilityID,
    package: finding.PkgName,
    product: finding.PkgIdentifier?.PURL ?? "",
    installedVersion: finding.InstalledVersion,
    fixedVersion: finding.FixedVersion ?? "",
    severity: String(finding.Severity ?? "UNKNOWN").toUpperCase(),
    kev: isKev(finding) || kevIds.has(finding.VulnerabilityID),
  };
}

/** Apply Felix's candidate-image policy without copying sensitive scan matches to output. */
export function evaluateImageReport(report, vex, review, now = new Date(), kevCatalog = { vulnerabilities: [] }) {
  const vulnerabilities = [];
  const blockers = [];
  const recorded = [];
  const suppressed = [];
  const policyErrors = [];
  if (!Array.isArray(kevCatalog.vulnerabilities)) {
    throw new Error("CISA KEV catalog must contain a vulnerabilities array");
  }
  const kevIds = new Set(kevCatalog.vulnerabilities.map((item) => item?.cveID).filter(Boolean));

  for (const result of report.Results ?? []) {
    for (const finding of result.Vulnerabilities ?? []) {
      vulnerabilities.push(vulnerabilityRecord(result.Target, finding, kevIds));
    }
    for (const secret of result.Secrets ?? []) {
      blockers.push({
        kind: "secret",
        target: result.Target,
        rule: secret.RuleID,
        severity: String(secret.Severity ?? "UNKNOWN").toUpperCase(),
        reason: "embedded_secret",
      });
    }
    for (const misconfiguration of result.Misconfigurations ?? []) {
      const severity = String(misconfiguration.Severity ?? "UNKNOWN").toUpperCase();
      if (["HIGH", "CRITICAL"].includes(severity) && String(misconfiguration.Status ?? "FAIL") !== "PASS") {
        blockers.push({
          kind: "misconfiguration",
          target: result.Target,
          id: misconfiguration.ID,
          severity,
          reason: "image_misconfiguration",
        });
      }
    }
  }

  const findingKeys = new Set(vulnerabilities.map((item) => key(item.vulnerability, item.product)));
  const reviews = new Map((review.reviews ?? []).map((item) => [key(item.vulnerability, item.product), item]));
  const validSuppressions = new Set();

  for (const statement of vex.statements ?? []) {
    if (statement.status !== "not_affected") continue;
    const vulnerability = statement.vulnerability?.name ?? "";
    const products = statement.products ?? [];
    if (!vulnerability || products.length === 0 || !statement.justification || !statement.impact_statement) {
      policyErrors.push(`incomplete not_affected statement for ${vulnerability || "unknown vulnerability"}`);
      continue;
    }
    for (const productEntry of products) {
      const product = productEntry["@id"] ?? productEntry.component_identifier ?? "";
      const statementKey = key(vulnerability, product);
      if (!findingKeys.has(statementKey)) {
        policyErrors.push(`unmatched VEX statement for ${vulnerability} and ${product || "missing product"}`);
        continue;
      }
      const metadata = reviews.get(statementKey);
      if (!metadata?.evidence || !metadata?.reviewer || !metadata?.reviewed_at || !metadata?.expires_at) {
        policyErrors.push(`missing VEX review metadata for ${vulnerability} and ${product}`);
        continue;
      }
      const reviewedAt = new Date(metadata.reviewed_at);
      const expiresAt = new Date(metadata.expires_at);
      if (Number.isNaN(reviewedAt.valueOf()) || Number.isNaN(expiresAt.valueOf())) {
        policyErrors.push(`invalid VEX review date for ${vulnerability} and ${product}`);
        continue;
      }
      if (expiresAt <= now) {
        policyErrors.push(`expired VEX statement for ${vulnerability} and ${product}`);
        continue;
      }
      if (reviewedAt > now) {
        policyErrors.push(`future-dated VEX review for ${vulnerability} and ${product}`);
        continue;
      }
      validSuppressions.add(statementKey);
    }
  }

  for (const finding of vulnerabilities) {
    const suppressionKey = key(finding.vulnerability, finding.product);
    const suppressedByVex = validSuppressions.has(suppressionKey);
    const fixableHigh = ["HIGH", "CRITICAL"].includes(finding.severity) && Boolean(finding.fixedVersion);
    if (fixableHigh) {
      blockers.push({ ...finding, reason: "fixable_critical_or_high" });
    } else if ((["HIGH", "CRITICAL"].includes(finding.severity) || finding.kev) && !suppressedByVex) {
      blockers.push({ ...finding, reason: finding.kev ? "cisa_kev" : "critical_or_high" });
    } else if (suppressedByVex) {
      suppressed.push({ ...finding, reason: "reviewed_not_affected" });
    } else {
      recorded.push(finding);
    }
  }

  return { blockers, recorded, suppressed, policyErrors };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    args.set(name.slice(2), value);
  }
  return args;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["report", "vex", "review", "kev", "output"]) {
    if (!args.has(required)) throw new Error(`--${required} is required`);
  }
  const result = evaluateImageReport(
    JSON.parse(readFileSync(args.get("report"), "utf8")),
    JSON.parse(readFileSync(args.get("vex"), "utf8")),
    JSON.parse(readFileSync(args.get("review"), "utf8")),
    new Date(),
    JSON.parse(readFileSync(args.get("kev"), "utf8")),
  );
  writeFileAtomic(args.get("output"), `${JSON.stringify(result, null, 2)}\n`, 0o600);
  if (result.blockers.length > 0 || result.policyErrors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
