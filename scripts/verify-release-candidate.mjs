#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    values[name.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.manifest) throw new Error("--manifest is required");
    verifyCandidate(JSON.parse(readFileSync(args.manifest, "utf8")), {
      runId: args["run-id"], version: args.version, commit: args.commit, digest: args.digest,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
