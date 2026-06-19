import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildWorkspacePaths, type WorkspacePaths } from "./workspace.js";
import { DEFAULT_ATTACHMENT_MAX_BYTES } from "./core/attachments.js";

const Env = z.object({
  WORKSPACE_DIR: z.string().default("./workspace"),
  CONFIG_DIR: z.string().default("./config"),
  SECRET_ENV_FILE: z.string().default("/run/secrets/.env"),
  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-5.4-mini"),
  CODEX_BYPASS_SANDBOX: z.coerce.boolean().default(true),
  CODEX_REASONING_EFFORT: z.string().default("high"),
  CODEX_TIMEOUT_SECONDS: z.coerce.number().default(1800),
  HARNESS: z.enum(["codex", "opencode"]).default("codex"),
  OPENCODE_BIN: z.string().default("opencode"),
  OPENCODE_MODEL: z.string().default("opencode/deepseek-v4-flash-free"),
  OPENCODE_VARIANT: z.string().optional(),
  OPENCODE_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OWNER_UI_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_ORGANIZATION: z.string().optional(),
  OPENAI_PROJECT: z.string().optional(),
  MATTERMOST_URL: z.string().optional(),
  MATTERMOST_TOKEN: z.string().optional(),
  MATTERMOST_BOT_USER_ID: z.string().optional(),
  MATTERMOST_BOT_USERNAME: z.string().optional(),
  MATTERMOST_BOT_DISPLAY: z.string().default("Felix"),
  MATTERMOST_OWNER_USER_ID: z.string().optional(),
  MATTERMOST_OWNER_DISPLAY: z.string().default("Owner"),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_BOT_USER_ID: z.string().optional(),
  DISCORD_OWNER_USER_ID: z.string().optional(),
  DISCORD_OWNER_DISPLAY: z.string().default("Owner"),
  SLACK_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_BOT_USER_ID: z.string().optional(),
  SLACK_OWNER_USER_ID: z.string().optional(),
  SLACK_OWNER_DISPLAY: z.string().default("Owner"),
  SOURCE: z.string().default("mattermost"),
  THREAD_SCAN_INTERVAL_MS: z.coerce.number().default(1000),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(DEFAULT_ATTACHMENT_MAX_BYTES),
});

export type AppConfig = z.infer<typeof Env> & {
  paths: WorkspacePaths;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configDir = env.CONFIG_DIR ?? "/home/node/config";
  const secretEnvFile = env.SECRET_ENV_FILE ?? "/run/secrets/.env";
  const merged = {
    ...env,
    ...readDotEnv(secretEnvFile),
    ...readDotEnv(path.join(configDir, ".env")),
  };
  // Inject loaded secrets into process.env so spawned child processes inherit them
  for (const [key, value] of Object.entries(merged)) {
    process.env[key] = String(value);
  }
  const parsed = Env.parse(merged);
  return {
    ...parsed,
    paths: buildWorkspacePaths(parsed.WORKSPACE_DIR),
  };
}

function readDotEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = unquote(trimmed.slice(idx + 1).trim());
    out[key] = value;
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
