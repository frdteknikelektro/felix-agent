#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseNamedArgs, requireNamedArgs } from "./cli-args.mjs";
import { writeFileAtomic } from "./setup-support.mjs";

const OPENVEX_STATUSES = new Set(["not_affected", "affected", "fixed", "under_investigation"]);
const OPENVEX_JUSTIFICATIONS = new Set([
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
]);
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDateTime(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(new Date(value).valueOf());
}

/** Validate the JSON-Schema subset used by the committed VEX review contract. */
export function validateJsonSchema(value, schema, path = "$review") {
  const errors = [];
  const type = schema?.type;
  const validType = type === "object" ? isRecord(value)
    : type === "array" ? Array.isArray(value)
      : type === "string" ? typeof value === "string"
        : true;
  if (!validType) return [`${path} must be ${type}`];

  if (type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const property of Object.keys(value)) {
        if (!(property in properties)) errors.push(`${path}.${property} is not allowed`);
      }
    }
    for (const [property, childSchema] of Object.entries(properties)) {
      if (property in value) errors.push(...validateJsonSchema(value[property], childSchema, `${path}.${property}`));
    }
  } else if (type === "array") {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(item, schema.items ?? {}, `${path}[${index}]`));
    });
  } else if (type === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      errors.push(`${path} must match ${schema.pattern}`);
    }
    if (schema.format === "date-time" && !isDateTime(value)) {
      errors.push(`${path} must be an RFC 3339 date-time`);
    }
  }
  return errors;
}

/** Validate the standalone OpenVEX fields that can influence suppression. */
export function validateOpenVexDocument(vex) {
  const errors = [];
  if (!isRecord(vex)) return ["$vex must be an object"];
  if (vex["@context"] !== "https://openvex.dev/ns/v0.2.0") errors.push("$vex.@context must identify OpenVEX v0.2.0");
  for (const field of ["@id", "author"]) {
    if (typeof vex[field] !== "string" || vex[field].trim() === "") errors.push(`$vex.${field} must be a non-empty string`);
  }
  if (!isDateTime(vex.timestamp)) errors.push("$vex.timestamp must be an RFC 3339 date-time");
  if (!Number.isInteger(vex.version) || vex.version < 1) errors.push("$vex.version must be a positive integer");
  if (!Array.isArray(vex.statements)) return [...errors, "$vex.statements must be an array"];

  const statementKeys = new Set();
  vex.statements.forEach((statement, index) => {
    const location = `$vex.statements[${index}]`;
    if (!isRecord(statement)) {
      errors.push(`${location} must be an object`);
      return;
    }
    const vulnerability = statement.vulnerability?.name;
    if (typeof vulnerability !== "string" || vulnerability.trim() === "") {
      errors.push(`${location}.vulnerability.name must be a non-empty string`);
    }
    if (!OPENVEX_STATUSES.has(statement.status)) errors.push(`${location}.status is not a valid OpenVEX status`);
    if (!Array.isArray(statement.products) || statement.products.length === 0) {
      errors.push(`${location}.products must identify at least one package PURL`);
    } else {
      for (const [productIndex, product] of statement.products.entries()) {
        const purl = product?.["@id"];
        if (typeof purl !== "string" || !purl.startsWith("pkg:")) {
          errors.push(`${location}.products[${productIndex}].@id must be a package PURL`);
          continue;
        }
        const statementKey = key(vulnerability ?? "", purl);
        if (statementKeys.has(statementKey)) errors.push(`${location} duplicates ${vulnerability} and ${purl}`);
        statementKeys.add(statementKey);
      }
    }
    if (statement.status === "not_affected") {
      if (!OPENVEX_JUSTIFICATIONS.has(statement.justification)) {
        errors.push(`${location}.justification is not a valid OpenVEX not_affected justification`);
      }
      if (typeof statement.impact_statement !== "string" || statement.impact_statement.trim() === "") {
        errors.push(`${location}.impact_statement must provide the reviewed non-applicability rationale`);
      }
    }
  });
  return errors;
}

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

/** Fingerprint the non-sensitive finding fields consumed by the release policy. */
export function policyReportFingerprint(report) {
  const findings = [];
  for (const result of report.Results ?? []) {
    for (const finding of result.Vulnerabilities ?? []) {
      findings.push(vulnerabilityRecord(result.Target, finding, new Set()));
    }
    for (const secret of result.Secrets ?? []) {
      findings.push({
        kind: "secret",
        target: result.Target,
        rule: secret.RuleID,
        severity: String(secret.Severity ?? "UNKNOWN").toUpperCase(),
      });
    }
    for (const misconfiguration of result.Misconfigurations ?? []) {
      findings.push({
        kind: "misconfiguration",
        target: result.Target,
        id: misconfiguration.ID,
        severity: String(misconfiguration.Severity ?? "UNKNOWN").toUpperCase(),
        status: String(misconfiguration.Status ?? "FAIL"),
      });
    }
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(findings)).digest("hex")}`;
}

/** Apply Felix's candidate-image policy without copying sensitive scan matches to output. */
export function evaluateImageReport(
  report,
  vex,
  review,
  now = new Date(),
  kevCatalog = { vulnerabilities: [] },
  reviewSchema,
) {
  const vulnerabilities = [];
  const blockers = [];
  const recorded = [];
  const suppressed = [];
  const policyErrors = [];
  if (!isRecord(reviewSchema)) throw new Error("committed VEX review schema is required");
  policyErrors.push(...validateOpenVexDocument(vex));
  policyErrors.push(...validateJsonSchema(review, reviewSchema));
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
  const reviewItems = Array.isArray(review?.reviews) ? review.reviews : [];
  const reviews = new Map();
  for (const item of reviewItems) {
    if (!isRecord(item)) continue;
    const reviewKey = key(item.vulnerability, item.product);
    if (reviews.has(reviewKey)) policyErrors.push(`duplicate VEX review for ${item.vulnerability} and ${item.product}`);
    reviews.set(reviewKey, item);
  }
  const statements = Array.isArray(vex?.statements) ? vex.statements : [];
  const vexReviewKeys = new Set();
  for (const statement of statements) {
    if (statement?.status !== "not_affected") continue;
    for (const product of statement.products ?? []) {
      if (statement.vulnerability?.name && product?.["@id"]) {
        vexReviewKeys.add(key(statement.vulnerability.name, product["@id"]));
      }
    }
  }
  for (const item of reviewItems) {
    if (isRecord(item) && !vexReviewKeys.has(key(item.vulnerability, item.product))) {
      policyErrors.push(`unmatched VEX review for ${item.vulnerability} and ${item.product}`);
    }
  }
  const validSuppressions = new Set();
  const suppressionContractValid = policyErrors.length === 0;

  for (const statement of statements) {
    if (statement.status !== "not_affected") continue;
    const vulnerability = statement.vulnerability?.name ?? "";
    const products = statement.products ?? [];
    if (!vulnerability || products.length === 0 || !statement.justification || !statement.impact_statement) {
      policyErrors.push(`incomplete not_affected statement for ${vulnerability || "unknown vulnerability"}`);
      continue;
    }
    for (const productEntry of products) {
      const product = productEntry["@id"] ?? productEntry.component_identifier ?? "";
      if (!product) {
        policyErrors.push(`missing product PURL for ${vulnerability}`);
        continue;
      }
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
      if (suppressionContractValid) validSuppressions.add(statementKey);
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

  return {
    subject: {
      artifactName: String(report.ArtifactName ?? ""),
      artifactType: String(report.ArtifactType ?? ""),
    },
    reportFingerprint: policyReportFingerprint(report),
    blockers,
    recorded,
    suppressed,
    policyErrors,
  };
}

function run() {
  const args = requireNamedArgs(
    parseNamedArgs(process.argv.slice(2)),
    ["report", "vex", "review", "review-schema", "kev", "output"],
  );
  const result = evaluateImageReport(
    JSON.parse(readFileSync(args.get("report"), "utf8")),
    JSON.parse(readFileSync(args.get("vex"), "utf8")),
    JSON.parse(readFileSync(args.get("review"), "utf8")),
    new Date(),
    JSON.parse(readFileSync(args.get("kev"), "utf8")),
    JSON.parse(readFileSync(args.get("review-schema"), "utf8")),
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
