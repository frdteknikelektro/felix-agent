import { describe, expect, it } from "vitest";
import { verifyCandidate } from "../scripts/verify-release-candidate.mjs";

const digest = `sha256:${"d".repeat(64)}`;
const commit = "1".repeat(40);
const manifest = { runId: "12345", version: "0.1.1", digest, commit };

describe("candidate-to-release binding", () => {
  it("accepts only the exact run, version, commit, and digest", () => {
    expect(verifyCandidate(manifest, manifest)).toEqual(manifest);
  });

  it.each([
    ["runId", "999"],
    ["version", "0.1.0"],
    ["commit", "2".repeat(40)],
    ["digest", `sha256:${"e".repeat(64)}`],
  ] as const)("rejects a mismatched %s", (field, value) => {
    expect(() => verifyCandidate(manifest, { ...manifest, [field]: value })).toThrow(new RegExp(field, "i"));
  });

  it("rejects mutable or malformed identifiers", () => {
    expect(() => verifyCandidate({ ...manifest, digest: "latest" }, manifest)).toThrow(/digest/i);
    expect(() => verifyCandidate({ ...manifest, commit: "main" }, manifest)).toThrow(/commit/i);
  });
});
