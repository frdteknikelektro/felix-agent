import { describe, expect, it } from "vitest";
import { classifyImageInspect } from "../scripts/assert-image-tag-absent.mjs";
import { classifyCompatibleImageInspect } from "../scripts/check-image-tag-compatible.mjs";

describe("immutable image tag lookup", () => {
  const reference = "frdinawan/felix-agent:0.1.1";

  it("accepts only an explicit registry not-found response as absence", () => {
    expect(classifyImageInspect({
      reference,
      status: 1,
      stderr: `ERROR: docker.io/${reference}: not found\n`,
    })).toBe("absent");
  });

  it("rejects an existing tag", () => {
    expect(() => classifyImageInspect({ reference, status: 0, stderr: "" })).toThrow(/already exists/i);
  });

  it.each([
    "ERROR: authorization failed",
    "ERROR: request canceled while waiting for connection",
    "ERROR: toomanyrequests: rate limit exceeded",
    "ERROR: repository does not exist or may require authorization",
  ])("fails closed for operational lookup error: %s", (stderr) => {
    expect(() => classifyImageInspect({ reference, status: 1, stderr })).toThrow(/unable to verify/i);
  });

  it("allows an existing release tag only when it already has the accepted digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(classifyCompatibleImageInspect({
      reference,
      expectedDigest: digest,
      status: 0,
      stdout: `Name: ${reference}\nMediaType: application/vnd.oci.image.index.v1+json\nDigest: ${digest}\n`,
      stderr: "",
    })).toBe("present");
    expect(() => classifyCompatibleImageInspect({
      reference,
      expectedDigest: digest,
      status: 0,
      stdout: `Digest: sha256:${"b".repeat(64)}\n`,
      stderr: "",
    })).toThrow(/different digest/i);
  });

  it("permits creation only after an explicit not-found response", () => {
    expect(classifyCompatibleImageInspect({
      reference,
      expectedDigest: `sha256:${"a".repeat(64)}`,
      status: 1,
      stdout: "",
      stderr: `ERROR: docker.io/${reference}: not found\n`,
    })).toBe("absent");
    expect(() => classifyCompatibleImageInspect({
      reference,
      expectedDigest: `sha256:${"a".repeat(64)}`,
      status: 1,
      stdout: "",
      stderr: "ERROR: authorization failed",
    })).toThrow(/unable to verify/i);
  });
});
