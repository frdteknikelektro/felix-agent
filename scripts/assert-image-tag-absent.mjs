#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function explicitNotFound(stderr) {
  return String(stderr)
    .split(/\r?\n/)
    .some((line) => /^ERROR:\s+\S+:\s+(?:not found|manifest unknown(?::.*)?)\s*$/i.test(line.trim()));
}

/** Classify a Buildx manifest lookup while preserving an existing digest. */
export function classifyImageLookup({ reference, status, stdout = "", stderr }) {
  if (!reference || /\s/.test(reference)) throw new Error("image reference must be a non-empty value without whitespace");
  if (status === 0) {
    const digest = String(stdout).match(/^Digest:\s+(sha256:[0-9a-f]{64})\s*$/mi)?.[1];
    return { state: "present", digest };
  }
  if (status === 1 && explicitNotFound(stderr)) return { state: "absent" };
  throw new Error(`unable to verify immutable image tag absence: inspect exited with status ${status ?? "unknown"}`);
}

/** Classify a Buildx manifest lookup without treating outages as tag absence. */
export function classifyImageInspect(result) {
  const lookup = classifyImageLookup(result);
  if (lookup.state === "present") throw new Error(`immutable image tag already exists: ${result.reference}`);
  return "absent";
}

export function inspectImageTag(reference, run = spawnSync) {
  const result = run("docker", ["buildx", "imagetools", "inspect", reference], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error("unable to verify immutable image tag absence: inspect could not start");
  return classifyImageLookup({
    reference,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export function assertImageTagAbsent(reference, run = spawnSync) {
  const lookup = inspectImageTag(reference, run);
  if (lookup.state === "present") throw new Error(`immutable image tag already exists: ${reference}`);
  return "absent";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: assert-image-tag-absent.mjs <image:tag>");
    assertImageTagAbsent(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
