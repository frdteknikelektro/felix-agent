#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function explicitNotFound(stderr) {
  return String(stderr)
    .split(/\r?\n/)
    .some((line) => /^ERROR:\s+\S+:\s+(?:not found|manifest unknown(?::.*)?)\s*$/i.test(line.trim()));
}

/** Classify a Buildx manifest lookup without treating outages as tag absence. */
export function classifyImageInspect({ reference, status, stderr }) {
  if (!reference || /\s/.test(reference)) throw new Error("image reference must be a non-empty value without whitespace");
  if (status === 0) throw new Error(`immutable image tag already exists: ${reference}`);
  if (status === 1 && explicitNotFound(stderr)) return "absent";
  throw new Error(`unable to verify immutable image tag absence: inspect exited with status ${status ?? "unknown"}`);
}

export function assertImageTagAbsent(reference, run = spawnSync) {
  const result = run("docker", ["buildx", "imagetools", "inspect", reference], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error("unable to verify immutable image tag absence: inspect could not start");
  return classifyImageInspect({ reference, status: result.status, stderr: result.stderr });
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
