#!/usr/bin/env node
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
}

const tempDir = await mkdtemp(join(tmpdir(), "felix-google-"));
const templatePath = join(tempDir, "credentials.json");
const template = JSON.stringify({
  installed: {
    client_id: "${GOOGLE_CLIENT_ID}",
    client_secret: "${GOOGLE_CLIENT_SECRET}",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: ["http://localhost"],
  },
});

try {
  await writeFile(templatePath, `${template}\n`, { mode: 0o600 });
  await chmod(templatePath, 0o600);
  const command = process.env.GOG_BIN || "gog";
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, ["auth", "credentials", "set", templatePath, "--expand-env"], {
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
