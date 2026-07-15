import {
  chmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const SECRET_KEY_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|AUTH_JSON|CREDENTIALS?)$/;

/** Classify credentials by semantic field name so new integrations are masked by default. */
export function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(String(key).toUpperCase());
}

/** Write a complete file through a same-directory temporary file and atomic rename. */
export function writeFileAtomic(file, content, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode });
    if (process.platform !== "win32") chmodSync(temporary, mode);
    renameSync(temporary, file);
    if (process.platform !== "win32") chmodSync(file, mode);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}
