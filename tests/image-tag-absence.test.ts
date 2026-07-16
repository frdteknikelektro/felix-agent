import { describe, expect, it } from "vitest";
import { classifyImageInspect } from "../scripts/assert-image-tag-absent.mjs";

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
});
