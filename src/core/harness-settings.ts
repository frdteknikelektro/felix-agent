import type { AppConfig } from "../config.js";
import { buildSpawnPath } from "./harness-common.js";

export interface HarnessSettings {
  model: string;
  env: Record<string, string | undefined>;
}

export function ninerouterEnabled(cfg: AppConfig): boolean {
  return Boolean(
    cfg.NINEROUTER_ENABLED &&
    cfg.NINEROUTER_API_KEY &&
    cfg.NINEROUTER_MODEL &&
    ninerouterOpenAiBaseUrl(cfg),
  );
}

export function ninerouterOpenAiBaseUrl(cfg: AppConfig): string {
  return cfg.NINEROUTER_OPENAI_BASE_URL || cfg.NINEROUTER_BASE_URL || "";
}

export function ninerouterAnthropicBaseUrl(cfg: AppConfig): string {
  return cfg.NINEROUTER_ANTHROPIC_BASE_URL || cfg.NINEROUTER_BASE_URL || "";
}

export function codexSettings(cfg: AppConfig): HarnessSettings {
  if (ninerouterEnabled(cfg)) {
    return {
      model: cfg.NINEROUTER_MODEL!,
      env: {
        WORKSPACE_DIR: cfg.WORKSPACE_DIR,
        OPENAI_API_KEY: cfg.NINEROUTER_API_KEY,
        OPENAI_BASE_URL: ninerouterOpenAiBaseUrl(cfg),
        OPENAI_ORGANIZATION: "",
        OPENAI_PROJECT: "",
        PATH: buildSpawnPath(cfg),
      },
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
    },
  };
}

export function opencodeSettings(cfg: AppConfig): HarnessSettings {
  if (ninerouterEnabled(cfg)) {
    const model = cfg.NINEROUTER_MODEL!;
    return {
      model: `9router/${model}`,
      env: {
        WORKSPACE_DIR: cfg.WORKSPACE_DIR,
        NINEROUTER_API_KEY: cfg.NINEROUTER_API_KEY,
        NINEROUTER_OPENAI_BASE_URL: ninerouterOpenAiBaseUrl(cfg),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          "$schema": "https://opencode.ai/config.json",
          provider: {
            "9router": {
              npm: "@ai-sdk/openai-compatible",
              name: "9router",
              options: {
                baseURL: "{env:NINEROUTER_OPENAI_BASE_URL}",
                apiKey: "{env:NINEROUTER_API_KEY}",
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
      DEEPSEEK_API_KEY: cfg.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY,
      PATH: buildSpawnPath(cfg),
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
        ANTHROPIC_AUTH_TOKEN: cfg.NINEROUTER_API_KEY,
        ANTHROPIC_BASE_URL: ninerouterAnthropicBaseUrl(cfg),
        PATH: buildSpawnPath(cfg),
      },
    };
  }

  return {
    model: cfg.CLAUDE_CODE_MODEL,
    env: {
      WORKSPACE_DIR: cfg.WORKSPACE_DIR,
      ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      PATH: buildSpawnPath(cfg),
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
    cfg.OPENROUTER_API_KEY ||
    cfg.DEEPSEEK_API_KEY
  );
}

export function hasClaudeCodeAuth(cfg: AppConfig): boolean {
  return ninerouterEnabled(cfg) || Boolean(cfg.ANTHROPIC_API_KEY);
}
