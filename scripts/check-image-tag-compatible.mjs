#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { classifyImageLookup, inspectImageTag } from "./assert-image-tag-absent.mjs";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Allow a release tag to be created or resumed, but never redirected. */
function classifyCompatibleLookup(lookup, reference, expectedDigest) {
  if (!DIGEST_PATTERN.test(String(expectedDigest))) throw new Error("expected image digest is invalid");
  if (lookup.state === "absent") return "absent";
  if (!lookup.digest) throw new Error("unable to verify existing immutable image tag digest");
  if (lookup.digest !== expectedDigest) {
    throw new Error(`existing immutable image tag points to a different digest: ${reference}`);
  }
  return "present";
}

export function classifyCompatibleImageInspect({
  reference,
  expectedDigest,
  status,
  stdout,
  stderr,
}) {
  return classifyCompatibleLookup(
    classifyImageLookup({ reference, status, stdout, stderr }),
    reference,
    expectedDigest,
  );
}

export function checkImageTagCompatible(reference, expectedDigest, run) {
  return classifyCompatibleLookup(inspectImageTag(reference, run), reference, expectedDigest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) {
      throw new Error("usage: check-image-tag-compatible.mjs <image:tag> <sha256:digest>");
    }
    console.log(checkImageTagCompatible(process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
