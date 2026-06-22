import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

describe("secret env file", () => {
  it("loads from SECRET_ENV_FILE", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-secret-env-"));
    const workspace = path.join(dir, "workspace");
    const secretEnv = path.join(dir, "run", "secrets", ".env");

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(secretEnv), { recursive: true });
    await fs.writeFile(
      secretEnv,
      [
        "OPENAI_API_KEY=sk-secret",
        "MATTERMOST_BOT_TOKEN=mm-secret",
        "CODEX_MODEL=gpt-secret",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    try {
      const cfg = loadConfig({
        WORKSPACE_DIR: workspace,
        SECRET_ENV_FILE: secretEnv,
      });

      expect(cfg.OPENAI_API_KEY).toBe("sk-secret");
      expect(cfg.MATTERMOST_BOT_TOKEN).toBe("mm-secret");
      expect(cfg.CODEX_MODEL).toBe("gpt-secret");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy token env var names", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-legacy-env-"));
    const workspace = path.join(dir, "workspace");
    const secretEnv = path.join(dir, "run", "secrets", ".env");

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(secretEnv), { recursive: true });
    await fs.writeFile(
      secretEnv,
      [
        "MATTERMOST_TOKEN=mm-legacy",
        "DISCORD_TOKEN=discord-legacy",
        "SLACK_TOKEN=slack-legacy",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    try {
      const cfg = loadConfig({
        WORKSPACE_DIR: workspace,
        SECRET_ENV_FILE: secretEnv,
      });

      expect(cfg.MATTERMOST_BOT_TOKEN).toBe("mm-legacy");
      expect(cfg.DISCORD_BOT_TOKEN).toBe("discord-legacy");
      expect(cfg.SLACK_BOT_TOKEN).toBe("slack-legacy");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
