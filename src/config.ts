import fs from "node:fs";
import { z } from "zod";
import { buildWorkspacePaths, type WorkspacePaths } from "./workspace.js";
import { DEFAULT_ATTACHMENT_MAX_BYTES } from "./core/attachments.js";

const BoolString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const Env = z.object({
  // Name shown to users when a source-specific identity is not available.
  FELIX_NAME: z.string().trim().min(1).default("Felix"),
  WORKSPACE_DIR: z.string().default("./workspace"),
  SECRET_ENV_FILE: z.string().default("/run/secrets/.env"),
  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-5.4-mini"),
  CODEX_MODEL_FOR_MEMORIZING: z.string().optional(),
  CODEX_BYPASS_SANDBOX: z.coerce.boolean().default(true),
  CODEX_REASONING_EFFORT: z.string().default("high"),
  HARNESS: z.enum(["codex", "opencode", "claude-code"]).default("codex"),
  OPENCODE_BIN: z.string().default("opencode"),
  OPENCODE_MODEL: z.string().default("opencode/deepseek-v4-flash-free"),
  OPENCODE_MODEL_FOR_MEMORIZING: z.string().optional(),
  OPENCODE_VARIANT: z.string().default("high"),
  OPENCODE_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  NINEROUTER_ENABLED: BoolString.default(false),
  NINEROUTER_KEY: z.string().optional(),
  NINEROUTER_MODEL: z.string().optional(),
  NINEROUTER_MODEL_FOR_MEMORIZING: z.string().optional(),
  NINEROUTER_URL: z.string().url().optional().or(z.literal("")),
  CLAUDE_CODE_BIN: z.string().default("claude"),
  CLAUDE_CODE_MODEL: z.string().default("sonnet"),
  CLAUDE_CODE_MODEL_FOR_MEMORIZING: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OWNER_UI_SECRET: z.string().min(8).optional(),
  // Set this when the owner console is served through an HTTPS reverse proxy.
  OWNER_UI_SECURE_COOKIE: BoolString.default(false),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_CODEX_AUTH_JSON: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional().or(z.literal("")),
  OPENAI_ORGANIZATION: z.string().optional(),
  OPENAI_PROJECT: z.string().optional(),
  MATTERMOST_URL: z.string().url().optional().or(z.literal("")),
  MATTERMOST_BOT_TOKEN: z.string().optional(),
  MATTERMOST_BOT_USER_ID: z.string().optional(),
  MATTERMOST_BOT_USERNAME: z.string().optional(),
  MATTERMOST_BOT_DISPLAY: z.string().default(""),
  MATTERMOST_OWNER_USER_ID: z.string().optional(),
  MATTERMOST_OWNER_USERNAME: z.string().optional(),
  MATTERMOST_OWNER_DISPLAY: z.string().default(""),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_BOT_USER_ID: z.string().optional(),
  DISCORD_OWNER_USER_ID: z.string().optional(),
  DISCORD_OWNER_DISPLAY: z.string().default("Owner"),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_BOT_USER_ID: z.string().optional(),
  SLACK_OWNER_USER_ID: z.string().optional(),
  SLACK_OWNER_DISPLAY: z.string().default("Owner"),
  WHATSAPP_BOT_ALIASES: z.string()
    .regex(/^[A-Za-z0-9_,]*$/, "WHATSAPP_BOT_ALIASES must be comma-separated letters, digits, and underscores")
    .optional()
    .transform((v) => v || undefined),
  WHATSAPP_OWNER_JID: z.string().optional(),
  WHATSAPP_OWNER_DISPLAY: z.string().default("Owner"),
  WHATSAPP_WACLI_BIN: z.string().default("wacli"),
  WHATSAPP_WEBHOOK_SECRET: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USER_ID: z.string().optional(),
  TELEGRAM_OWNER_USER_ID: z.string().optional(),
  TELEGRAM_OWNER_DISPLAY: z.string().default("Owner"),
  TELEGRAM_MODE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["polling", "webhook"]).default("polling"),
  ),
  TELEGRAM_WEBHOOK_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOG_HOME: z.string().default("/home/node/.config/gogcli"),
  GOG_KEYRING_BACKEND: z.string().default("file"),
  GOG_KEYRING_PASSWORD: z.string().optional(),
  SOURCE: z.string().default("mattermost"),
  // Empty string (an unset OWNER_CHANNEL= line in .env) means "route to the
  // event's own channel" — coerce it to undefined before the enum check, which
  // would otherwise reject "" and crash boot.
  OWNER_CHANNEL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["mattermost", "discord", "slack", "whatsapp", "telegram"]).optional(),
  ),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(DEFAULT_ATTACHMENT_MAX_BYTES),
  // IANA timezone for usage day/week/month boundaries (e.g. "Asia/Jakarta").
  USAGE_TZ: z.string().default("UTC"),
}).superRefine((env, ctx) => {
  if (env.NINEROUTER_ENABLED) {
    const required: Array<keyof typeof env> = [
      "NINEROUTER_KEY",
      "NINEROUTER_MODEL",
      "NINEROUTER_URL",
    ];
    for (const key of required) {
      const value = env[key];
      if (typeof value !== "string" || value.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when NINEROUTER_ENABLED=true`,
        });
      }
    }
  }
  if (env.TELEGRAM_MODE === "webhook") {
    if (!env.TELEGRAM_WEBHOOK_URL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["TELEGRAM_WEBHOOK_URL"], message: "TELEGRAM_WEBHOOK_URL is required when TELEGRAM_MODE=webhook" });
    } else {
      try {
        if (new URL(env.TELEGRAM_WEBHOOK_URL).protocol !== "https:") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["TELEGRAM_WEBHOOK_URL"], message: "TELEGRAM_WEBHOOK_URL must use HTTPS when TELEGRAM_MODE=webhook" });
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["TELEGRAM_WEBHOOK_URL"], message: "TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL when TELEGRAM_MODE=webhook" });
      }
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["TELEGRAM_WEBHOOK_SECRET"], message: "TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook" });
    }
  }
});

export type AppConfig = z.infer<typeof Env> & {
  paths: WorkspacePaths;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const explicitSecretFile = env.SECRET_ENV_FILE;
  const secretEnvFile = explicitSecretFile ?? "/run/secrets/.env";
  // Production mounts the secrets file at /run/secrets/.env. For local `npm run
  // dev` that mount is absent, so fall back to a repo-root .env. This convenience
  // applies only to the real runtime env — callers that inject an explicit env
  // (tests) get hermetic behavior — and never overrides an explicit SECRET_ENV_FILE.
  const isRealRuntime = env === process.env && !env.VITEST;
  const allowDotenvFallback = isRealRuntime && !explicitSecretFile && !fs.existsSync(secretEnvFile);
  const dotenvFile = allowDotenvFallback ? ".env" : secretEnvFile;
  const merged = {
    ...env,
    ...readDotEnv(dotenvFile),
  };

  // Migrate legacy env var names (backward compatibility)
  const legacyTokenMap: Record<string, string> = {
    MATTERMOST_TOKEN: "MATTERMOST_BOT_TOKEN",
    DISCORD_TOKEN: "DISCORD_BOT_TOKEN",
    SLACK_TOKEN: "SLACK_BOT_TOKEN",
  };
  for (const [oldKey, newKey] of Object.entries(legacyTokenMap)) {
    if (!merged[newKey] && merged[oldKey]) {
      merged[newKey] = merged[oldKey];
    }
  }

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
