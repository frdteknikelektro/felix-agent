import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSecretKey, writeFileAtomic } from "../scripts/setup-support.mjs";

describe("setup secret classification", () => {
  it.each([
    "OWNER_UI_SECRET",
    "OPENAI_API_KEY",
    "OPENAI_CODEX_AUTH_JSON",
    "ANTHROPIC_API_KEY",
    "NINEROUTER_KEY",
    "MATTERMOST_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "WHATSAPP_WEBHOOK_SECRET",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "GOG_KEYRING_PASSWORD",
  ])("classifies %s as sensitive", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(["FELIX_NAME", "MATTERMOST_URL", "DISCORD_OWNER_USER_ID", "OPENAI_MODEL"])(
    "does not hide ordinary setting %s",
    (key) => expect(isSecretKey(key)).toBe(false),
  );
});

describe("atomic setup writes", () => {
  it("creates a new environment file with owner-only permissions and no temp residue", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-setup-write-"));
    const target = path.join(dir, ".env");
    await writeFileAtomic(target, "OWNER_UI_SECRET=hidden\n", 0o600);

    expect(await fs.readFile(target, "utf8")).toBe("OWNER_UI_SECRET=hidden\n");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual([".env"]);
  });

  it("preserves the destination and cleans temporary files when rename cannot complete", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-setup-fail-"));
    const target = path.join(dir, ".env");
    await fs.mkdir(target);
    expect(() => writeFileAtomic(target, "SECRET=value\n", 0o600)).toThrow();
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    expect(await fs.readdir(dir)).toEqual([".env"]);
  });
});
