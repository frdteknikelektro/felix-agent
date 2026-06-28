import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { codexAuthForTest, ensureCodexAuth } from "../src/adapters/codex/index.js";
import {
  claudeCodeSettings,
  codexSettings,
  ninerouterAnthropicBaseUrl,
  ninerouterOpenAiBaseUrl,
  opencodeSettings,
} from "../src/core/harness-settings.js";
import { makeTestConfig } from "./helpers/workspace.js";

async function withSecretEnv(lines: string[], run: (secretEnv: string, workspace: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-ninerouter-"));
  const workspace = path.join(dir, "workspace");
  const secretEnv = path.join(dir, "run", "secrets", ".env");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.dirname(secretEnv), { recursive: true });
  await fs.writeFile(secretEnv, lines.join("\n") + "\n", { mode: 0o600 });
  try {
    await run(secretEnv, workspace);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("9router config", () => {
  it("defaults to disabled", async () => {
    await withSecretEnv([], async (secretEnv, workspace) => {
      const cfg = loadConfig({
        WORKSPACE_DIR: workspace,
        SECRET_ENV_FILE: secretEnv,
      });

      expect(cfg.NINEROUTER_ENABLED).toBe(false);
    });
  });

  it("treats NINEROUTER_ENABLED=false as disabled", async () => {
    await withSecretEnv(
      [
        "NINEROUTER_ENABLED=false",
        "NINEROUTER_BASE_URL=https://9router.jala.tech",
      ],
      async (secretEnv, workspace) => {
        const cfg = loadConfig({
          WORKSPACE_DIR: workspace,
          SECRET_ENV_FILE: secretEnv,
        });

        expect(cfg.NINEROUTER_ENABLED).toBe(false);
      },
    );
  });

  it("loads enabled config and falls protocol URLs back to the shared base URL", async () => {
    await withSecretEnv(
      [
        "NINEROUTER_ENABLED=true",
        "NINEROUTER_API_KEY=nr-secret",
        "NINEROUTER_MODEL=gpt-router",
        "NINEROUTER_BASE_URL=https://9router.jala.tech",
      ],
      async (secretEnv, workspace) => {
        const cfg = loadConfig({
          WORKSPACE_DIR: workspace,
          SECRET_ENV_FILE: secretEnv,
        });

        expect(cfg.NINEROUTER_ENABLED).toBe(true);
        expect(ninerouterOpenAiBaseUrl(cfg)).toBe("https://9router.jala.tech");
        expect(ninerouterAnthropicBaseUrl(cfg)).toBe("https://9router.jala.tech");
      },
    );
  });

  it("requires key, model, and base URL when enabled", async () => {
    await withSecretEnv(["NINEROUTER_ENABLED=true"], async (secretEnv, workspace) => {
      expect(() => loadConfig({
        WORKSPACE_DIR: workspace,
        SECRET_ENV_FILE: secretEnv,
      })).toThrow(/NINEROUTER_API_KEY/);
    });
  });
});

describe("9router harness settings", () => {
  async function cfg() {
    return makeTestConfig("felix-ninerouter-settings-", {
      NINEROUTER_ENABLED: true,
      NINEROUTER_API_KEY: "nr-secret",
      NINEROUTER_MODEL: "router-model",
      NINEROUTER_BASE_URL: "https://9router.jala.tech",
      NINEROUTER_OPENAI_BASE_URL: "https://9router.jala.tech/openai",
      NINEROUTER_ANTHROPIC_BASE_URL: "https://9router.jala.tech/anthropic",
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: "https://api.openai.example",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENCODE_API_KEY: "opencode-secret",
    });
  }

  it("overrides Codex key, base URL, and model", async () => {
    const settings = codexSettings(await cfg());

    expect(settings.model).toBe("router-model");
    expect(settings.env.OPENAI_API_KEY).toBe("nr-secret");
    expect(settings.env.OPENAI_BASE_URL).toBe("https://9router.jala.tech/openai");
    expect(settings.env.OPENAI_ORGANIZATION).toBe("");
    expect(settings.env.OPENAI_PROJECT).toBe("");
  });

  it("overrides Claude Code auth token, base URL, and model", async () => {
    const settings = claudeCodeSettings(await cfg());

    expect(settings.model).toBe("router-model");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("nr-secret");
    expect(settings.env.ANTHROPIC_API_KEY).toBe("");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://9router.jala.tech/anthropic");
  });

  it("injects an Opencode custom provider and model prefix", async () => {
    const settings = opencodeSettings(await cfg());
    const content = JSON.parse(settings.env.OPENCODE_CONFIG_CONTENT ?? "{}");

    expect(settings.model).toBe("9router/router-model");
    expect(settings.env.NINEROUTER_API_KEY).toBe("nr-secret");
    expect(settings.env.NINEROUTER_OPENAI_BASE_URL).toBe("https://9router.jala.tech/openai");
    expect(content.provider["9router"].npm).toBe("@ai-sdk/openai-compatible");
    expect(content.provider["9router"].options.baseURL).toBe("{env:NINEROUTER_OPENAI_BASE_URL}");
    expect(content.provider["9router"].options.apiKey).toBe("{env:NINEROUTER_API_KEY}");
    expect(content.provider["9router"].models["router-model"].name).toBe("router-model");
  });
});

describe("9router Codex auth", () => {
  const originalSpawnSync = codexAuthForTest.spawnSync;

  afterEach(() => {
    codexAuthForTest.spawnSync = originalSpawnSync;
  });

  it("skips codex login when 9router is enabled", async () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    codexAuthForTest.spawnSync = spawn as unknown as typeof codexAuthForTest.spawnSync;

    await ensureCodexAuth(await makeTestConfig("felix-ninerouter-codex-auth-", {
      NINEROUTER_ENABLED: true,
      NINEROUTER_API_KEY: "nr-secret",
      NINEROUTER_MODEL: "router-model",
      NINEROUTER_BASE_URL: "https://9router.jala.tech",
      OPENAI_API_KEY: "openai-secret",
    }));

    expect(spawn).not.toHaveBeenCalled();
  });
});
