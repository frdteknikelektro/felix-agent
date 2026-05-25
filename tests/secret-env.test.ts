import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

describe("secret env file precedence", () => {
  it("loads from /run/secrets/.env and lets config/.env override it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-secret-env-"));
    const workspace = path.join(dir, "workspace");
    const config = path.join(dir, "config");
    const secretEnv = path.join(dir, "run", "secrets", ".env");

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(secretEnv), { recursive: true });
    await fs.mkdir(config, { recursive: true });
    await fs.writeFile(
      secretEnv,
      [
        "OPENAI_API_KEY=sk-secret",
        "MATTERMOST_TOKEN=mm-secret",
        "CODEX_MODEL=gpt-secret",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(config, ".env"),
      [
        "MATTERMOST_TOKEN=mm-config",
        "CODEX_MODEL=gpt-config",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    try {
      const cfg = loadConfig({
        WORKSPACE_DIR: workspace,
        CONFIG_DIR: config,
        SECRET_ENV_FILE: secretEnv,
      });

      expect(cfg.OPENAI_API_KEY).toBe("sk-secret");
      expect(cfg.MATTERMOST_TOKEN).toBe("mm-config");
      expect(cfg.CODEX_MODEL).toBe("gpt-config");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
