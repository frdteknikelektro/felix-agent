import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const SECRET_KEY_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|AUTH_JSON|CREDENTIALS?|CLIENT_ID)$/;

/** Classify credentials by semantic field name so new integrations are masked by default. */
export function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(String(key).toUpperCase());
}

/** Render environment values for setup hints and review without leaking credentials. */
export function displayEnvValue(key, value) {
  if (!value) return "<not set>";
  return isSecretKey(key) ? "<redacted>" : String(value);
}

/** Mask every credential character; never reveal a trailing character while typing. */
export function maskSecretInput(value) {
  return "*".repeat(String(value ?? "").length);
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

export function parseSetupTemplate(file) {
  const raw = readFileSync(file, "utf8");
  return raw.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { type: "blank", raw: line };
    if (trimmed.startsWith("#")) {
      const inner = trimmed.slice(1).trim();
      const equals = inner.indexOf("=");
      if (equals > 0) {
        return {
          type: "optional",
          raw: line,
          key: inner.slice(0, equals).trim(),
          value: inner.slice(equals + 1).trim(),
        };
      }
      return { type: "comment", raw: line };
    }
    const equals = trimmed.indexOf("=");
    if (equals < 1) return { type: "comment", raw: line };
    return {
      type: "setting",
      raw: line,
      key: trimmed.slice(0, equals).trim(),
      value: trimmed.slice(equals + 1).trim(),
    };
  });
}

function quoteEnvValue(value) {
  const stringValue = String(value ?? "");
  if (/[\s"'#]/.test(stringValue) || stringValue.includes("\n")) {
    return `'${stringValue.replace(/'/g, "'\\''")}'`;
  }
  return stringValue;
}

/** Render the setup template and atomically publish it to the configured path. */
export function writeSetupEnv(templatePath, outputPath, answers, existing = {}) {
  const template = parseSetupTemplate(templatePath);
  const templateKeys = new Set();
  const lines = template.map((entry) => {
    if (entry.type === "setting") {
      templateKeys.add(entry.key);
      if (entry.key in answers) {
        const equals = entry.raw.indexOf("=");
        return entry.raw.slice(0, equals + 1) + quoteEnvValue(answers[entry.key]);
      }
      return entry.raw;
    }
    if (entry.type === "optional") {
      templateKeys.add(entry.key);
      if (entry.key in answers && answers[entry.key]) {
        return `${entry.key}=${quoteEnvValue(answers[entry.key])}`;
      }
    }
    return entry.raw;
  });

  const extra = new Set([
    ...Object.keys(answers).filter((key) => !templateKeys.has(key)),
    ...Object.keys(existing).filter(
      (key) => !templateKeys.has(key) && !(key in answers) && existing[key],
    ),
  ]);
  if (extra.size > 0) {
    lines.push("", "# ── Extra environment ──────────────────────────");
    for (const key of [...extra].sort()) {
      const value = key in answers ? answers[key] : existing[key];
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  writeFileAtomic(outputPath, `${lines.join("\n")}\n`, 0o600);
}
