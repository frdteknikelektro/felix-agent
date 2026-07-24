#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writePrivateFileAtomic } from "./atomic-file.mjs";

// Which gog client bucket and which env vars carry its OAuth client id/secret.
// Defaults keep the original behavior (the "default" client, GOOGLE_CLIENT_ID/
// GOOGLE_CLIENT_SECRET). Callers may pass --client/--id-env/--secret-env to
// import a differently-named client whose id/secret live in other env vars.
function readArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}
const client = readArg("--client", "default");
const idEnv = readArg("--id-env", "GOOGLE_CLIENT_ID");
const secretEnv = readArg("--secret-env", "GOOGLE_CLIENT_SECRET");

// Only the presence of the client id/secret is checked here — the values
// themselves stay in the environment and are referenced (not embedded) via
// gog's --expand-env so secrets never land in the template file.
const clientId = process.env[idEnv]?.trim();
const clientSecret = process.env[secretEnv]?.trim();
if (!clientId || !clientSecret) {
  throw new Error(`${idEnv} and ${secretEnv} must be set`);
}

const tempDir = await mkdtemp(join(tmpdir(), "felix-google-"));
const templatePath = join(tempDir, "credentials.json");
const template = JSON.stringify({
  installed: {
    client_id: `\${${idEnv}}`,
    client_secret: `\${${secretEnv}}`,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: ["http://localhost"],
  },
});

try {
  await writePrivateFileAtomic(templatePath, `${template}\n`);
  const command = process.env.GOG_BIN || "gog";
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, ["auth", "credentials", "set", templatePath, "--client", client, "--expand-env"], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) process.exitCode = Number(exitCode);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
