import type { AppConfig } from "../config.js";
import { buildSpawnPath } from "./harness-common.js";

export interface HarnessSettings {
  model: string;
  env: Record<string, string | undefined>;
  codexConfigArgs?: string[];
}

export function ninerouterEnabled(cfg: AppConfig): boolean {
  return Boolean(
    cfg.NINEROUTER_ENABLED &&
    cfg.NINEROUTER_KEY &&
    cfg.NINEROUTER_MODEL &&
    ninerouterOpenAiBaseUrl(cfg),
  );
}

export function ninerouterOpenAiBaseUrl(cfg: AppConfig): string {
  return withOpenAiV1(cfg.NINEROUTER_URL || "");
}

export function ninerouterAnthropicBaseUrl(cfg: AppConfig): string {
  // Claude Code appends /v1/messages itself, so hand it the bare base. Strip a
  // trailing /v1 a user may have copied from the OpenAI-style URL, which would
  // otherwise produce /v1/v1/messages.
  const trimmed = (cfg.NINEROUTER_URL || "").trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

export function withOpenAiV1(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  if (/\/v1$/i.test(withoutTrailing)) return withoutTrailing;
  return `${withoutTrailing}/v1`;
}

export function codexSettings(cfg: AppConfig): HarnessSettings {
  if (ninerouterEnabled(cfg)) {
    const baseUrl = ninerouterOpenAiBaseUrl(cfg);
    return {
      model: cfg.NINEROUTER_MODEL!,
      env: {
        WORKSPACE_DIR: cfg.WORKSPACE_DIR,
        OPENAI_API_KEY: cfg.NINEROUTER_KEY,
        OPENAI_BASE_URL: baseUrl,
        NINEROUTER_KEY: cfg.NINEROUTER_KEY,
        OPENAI_ORGANIZATION: "",
        OPENAI_PROJECT: "",
        PATH: buildSpawnPath(cfg),
        ...googleWorkspaceEnv(cfg),
      },
      codexConfigArgs: [
        "-c", `openai_base_url=${tomlString(baseUrl)}`,
        "-c", `model_provider=${tomlString("9router")}`,
        "-c", `model_providers.9router.name=${tomlString("9router")}`,
        "-c", `model_providers.9router.base_url=${tomlString(baseUrl)}`,
        "-c", `model_providers.9router.env_key=${tomlString("NINEROUTER_KEY")}`,
        "-c", `model_providers.9router.wire_api=${tomlString("responses")}`,
      ],
    };
  }

  return {
    model: cfg.CODEX_MODEL,
    env: {
      WORKSPACE_DIR: cfg.WORKSPACE_DIR,
      ...(cfg.OPENAI_API_KEY ? { OPENAI_API_KEY: cfg.OPENAI_API_KEY } : {}),
      OPENAI_BASE_URL: cfg.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
      OPENAI_ORGANIZATION: cfg.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORGANIZATION,
      OPENAI_PROJECT: cfg.OPENAI_PROJECT ?? process.env.OPENAI_PROJECT,
      PATH: buildSpawnPath(cfg),
      ...googleWorkspaceEnv(cfg),
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function googleWorkspaceEnv(cfg: AppConfig): Record<string, string | undefined> {
  return {
    ...(cfg.GOOGLE_CLIENT_ID ? { GOOGLE_CLIENT_ID: cfg.GOOGLE_CLIENT_ID } : {}),
    ...(cfg.GOOGLE_CLIENT_SECRET ? { GOOGLE_CLIENT_SECRET: cfg.GOOGLE_CLIENT_SECRET } : {}),
    ...(cfg.GOG_HOME ? { GOG_HOME: cfg.GOG_HOME } : {}),
    ...(cfg.GOG_KEYRING_BACKEND ? { GOG_KEYRING_BACKEND: cfg.GOG_KEYRING_BACKEND } : {}),
    ...(cfg.GOG_KEYRING_PASSWORD ? { GOG_KEYRING_PASSWORD: cfg.GOG_KEYRING_PASSWORD } : {}),
  };
}

export function opencodeSettings(cfg: AppConfig): HarnessSettings {
  if (ninerouterEnabled(cfg)) {
    const model = cfg.NINEROUTER_MODEL!;
    return {
      model: `9router/${model}`,
      env: {
        WORKSPACE_DIR: cfg.WORKSPACE_DIR,
        NINEROUTER_KEY: cfg.NINEROUTER_KEY,
        NINEROUTER_OPENAI_BASE_URL: ninerouterOpenAiBaseUrl(cfg),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          "$schema": "https://opencode.ai/config.json",
          provider: {
            "9router": {
              npm: "@ai-sdk/openai-compatible",
              name: "9router",
              options: {
                baseURL: "{env:NINEROUTER_OPENAI_BASE_URL}",
                apiKey: "{env:NINEROUTER_KEY}",
              },
              models: {
                [model]: {
                  name: model,
                },
              },
            },
          },
        }),
        PATH: buildSpawnPath(cfg),
        ...googleWorkspaceEnv(cfg),
      },
    };
  }

  return {
    model: cfg.OPENCODE_MODEL,
    env: {
      WORKSPACE_DIR: cfg.WORKSPACE_DIR,
      OPENAI_API_KEY: cfg.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      OPENCODE_API_KEY: cfg.OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY,
      OPENROUTER_API_KEY: cfg.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
      PATH: buildSpawnPath(cfg),
      ...googleWorkspaceEnv(cfg),
    },
  };
}

export function claudeCodeSettings(cfg: AppConfig): HarnessSettings {
  if (ninerouterEnabled(cfg)) {
    return {
      model: cfg.NINEROUTER_MODEL!,
      env: {
        WORKSPACE_DIR: cfg.WORKSPACE_DIR,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: cfg.NINEROUTER_KEY,
        ANTHROPIC_BASE_URL: ninerouterAnthropicBaseUrl(cfg),
        PATH: buildSpawnPath(cfg),
        ...googleWorkspaceEnv(cfg),
      },
    };
  }

  return {
    model: cfg.CLAUDE_CODE_MODEL,
    env: {
      WORKSPACE_DIR: cfg.WORKSPACE_DIR,
      ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: cfg.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
      PATH: buildSpawnPath(cfg),
      ...googleWorkspaceEnv(cfg),
    },
  };
}

export function hasCodexAuth(cfg: AppConfig): boolean {
  return ninerouterEnabled(cfg) || Boolean(cfg.OPENAI_API_KEY);
}

export function hasOpencodeAuth(cfg: AppConfig): boolean {
  return ninerouterEnabled(cfg) || Boolean(
    cfg.OPENAI_API_KEY ||
    cfg.OPENCODE_API_KEY ||
    cfg.OPENROUTER_API_KEY
  );
}

export function hasClaudeCodeAuth(cfg: AppConfig): boolean {
  return ninerouterEnabled(cfg) || Boolean(cfg.ANTHROPIC_API_KEY || cfg.CLAUDE_CODE_OAUTH_TOKEN);
}

export function codexModelForMemorizing(cfg: AppConfig): string {
  if (ninerouterEnabled(cfg)) {
    if (!cfg.NINEROUTER_MODEL_FOR_MEMORIZING) throw new Error("NINEROUTER_MODEL_FOR_MEMORIZING is required");
    return cfg.NINEROUTER_MODEL_FOR_MEMORIZING;
  }
  return cfg.CODEX_MODEL_FOR_MEMORIZING;
}

export function opencodeModelForMemorizing(cfg: AppConfig): string {
  if (ninerouterEnabled(cfg)) {
    if (!cfg.NINEROUTER_MODEL_FOR_MEMORIZING) throw new Error("NINEROUTER_MODEL_FOR_MEMORIZING is required");
    return cfg.NINEROUTER_MODEL_FOR_MEMORIZING;
  }
  return cfg.OPENCODE_MODEL_FOR_MEMORIZING;
}

export function claudeCodeModelForMemorizing(cfg: AppConfig): string {
  if (ninerouterEnabled(cfg)) {
    if (!cfg.NINEROUTER_MODEL_FOR_MEMORIZING) throw new Error("NINEROUTER_MODEL_FOR_MEMORIZING is required");
    return cfg.NINEROUTER_MODEL_FOR_MEMORIZING;
  }
  return cfg.CLAUDE_CODE_MODEL_FOR_MEMORIZING;
}

export function modelForMemorizing(cfg: AppConfig): string {
  if (cfg.HARNESS === "codex") return codexModelForMemorizing(cfg);
  if (cfg.HARNESS === "opencode") return opencodeModelForMemorizing(cfg);
  return claudeCodeModelForMemorizing(cfg);
}
