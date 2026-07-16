#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseNamedArgs, requireNamedArgs } from "./cli-args.mjs";

export function verifyCandidate(manifest, expected) {
  if (!/^\d+$/.test(String(manifest.runId))) throw new Error("candidate runId must be numeric");
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) throw new Error("candidate version is invalid");
  if (!/^[0-9a-f]{40}$/.test(String(manifest.commit))) throw new Error("candidate commit must be a full SHA-1");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(manifest.digest))) throw new Error("candidate digest is invalid");
  for (const field of ["runId", "version", "commit", "digest"]) {
    if (String(manifest[field]) !== String(expected[field])) throw new Error(`candidate ${field} does not match`);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = requireNamedArgs(
      parseNamedArgs(process.argv.slice(2)),
      ["manifest", "run-id", "version", "commit", "digest"],
    );
    verifyCandidate(JSON.parse(readFileSync(args.get("manifest"), "utf8")), {
      runId: args.get("run-id"), version: args.get("version"), commit: args.get("commit"), digest: args.get("digest"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
