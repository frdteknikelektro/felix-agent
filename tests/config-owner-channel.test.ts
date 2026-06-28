import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

async function withSecretEnv(
  lines: string[],
  run: (secretEnv: string, workspace: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-owner-channel-"));
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

describe("OWNER_CHANNEL config", () => {
  it("coerces an empty OWNER_CHANNEL= line to undefined without throwing", async () => {
    await withSecretEnv(["OWNER_CHANNEL="], async (secretEnv, workspace) => {
      const cfg = loadConfig({ WORKSPACE_DIR: workspace, SECRET_ENV_FILE: secretEnv });
      expect(cfg.OWNER_CHANNEL).toBeUndefined();
    });
  });

  it("accepts a valid channel", async () => {
    await withSecretEnv(["OWNER_CHANNEL=whatsapp"], async (secretEnv, workspace) => {
      const cfg = loadConfig({ WORKSPACE_DIR: workspace, SECRET_ENV_FILE: secretEnv });
      expect(cfg.OWNER_CHANNEL).toBe("whatsapp");
    });
  });

  it("rejects an invalid channel", async () => {
    await withSecretEnv(["OWNER_CHANNEL=telegram"], async (secretEnv, workspace) => {
      expect(() => loadConfig({ WORKSPACE_DIR: workspace, SECRET_ENV_FILE: secretEnv })).toThrow();
    });
  });
});
