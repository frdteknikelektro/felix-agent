import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  displayEnvValue,
  isSecretKey,
  maskSecretInput,
  withoutLegacyOwnerPresentation,
  writeFileAtomic,
  writeSetupEnv,
} from "../scripts/setup-support.mjs";

const knownCredentialKeys = [
  "OWNER_UI_SECRET",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_AUTH_JSON",
  "ANTHROPIC_API_KEY",
  "NINEROUTER_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "DB_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOG_KEY",
  "MATTERMOST_BOT_TOKEN",
  "MATTERMOST_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_TOKEN",
  "WHATSAPP_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "GOG_KEYRING_PASSWORD",
];

describe("setup secret classification", () => {
  it.each(knownCredentialKeys)("classifies %s as sensitive", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(knownCredentialKeys)("redacts the complete %s value", (key) => {
    const value = `distinct-${key}-credential-value-1234`;
    expect(displayEnvValue(key, value)).toBe("<redacted>");
    expect(displayEnvValue(key, value)).not.toContain(value);
  });

  it.each([
    "MATTERMOST_OWNER_USER_ID",
    "DISCORD_OWNER_USER_ID",
    "SLACK_OWNER_USER_ID",
    "WHATSAPP_OWNER_JID",
    "TELEGRAM_OWNER_USER_ID",
  ])("redacts the stable owner identifier %s from setup review", (key) => {
    expect(isSecretKey(key)).toBe(true);
    expect(displayEnvValue(key, "stable-owner-id")).toBe("<redacted>");
  });

  it.each(["FELIX_NAME", "MATTERMOST_URL", "OPENAI_MODEL"])(
    "does not hide ordinary setting %s",
    (key) => expect(isSecretKey(key)).toBe(false),
  );

  it("never includes any raw credential characters in review output", () => {
    const value = "distinct-secret-value-1234";
    expect(displayEnvValue("OPENAI_API_KEY", value)).toBe("<redacted>");
    expect(displayEnvValue("OPENAI_API_KEY", value)).not.toContain("1234");
    expect(displayEnvValue("FELIX_NAME", "Ada")).toBe("Ada");
    expect(displayEnvValue("OPENAI_API_KEY", "")).toBe("<not set>");
  });

  it("masks every character while a credential is being entered", () => {
    const value = "distinct-secret-value-1234";
    expect(maskSecretInput(value, { isFinal: false })).toBe("*".repeat(value.length));
    expect(maskSecretInput(value, { isFinal: true })).toBe("*".repeat(value.length));
    expect(maskSecretInput(value, { isFinal: false })).not.toContain("1234");
  });
});

describe("atomic setup writes", () => {
  it("creates the configured .env from a clean configuration directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-clean-setup-"));
    const target = path.join(root, "config", ".env");
    const ownerSecret = "generated-owner-secret-1234567890";

    writeSetupEnv(".env.example", target, {
      FELIX_NAME: "Felix",
      OWNER_UI_SECRET: ownerSecret,
      HARNESS: "codex",
    }, {});

    const contents = await fs.readFile(target, "utf8");
    expect(contents).toContain("FELIX_NAME=Felix");
    expect(contents).toContain(`OWNER_UI_SECRET=${ownerSecret}`);
    expect(contents).toContain("HARNESS=codex");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(target))).toEqual([".env"]);
  });

  it("rewrites setup output with stable owner identifiers and without legacy presentation fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "felix-owner-rewrite-"));
    const target = path.join(dir, ".env");
    const existing = withoutLegacyOwnerPresentation({
      MATTERMOST_OWNER_USERNAME: "legacy-name",
      MATTERMOST_OWNER_DISPLAY: "Legacy Mattermost Owner",
      DISCORD_OWNER_DISPLAY: "Legacy Discord Owner",
      SLACK_OWNER_DISPLAY: "Legacy Slack Owner",
      WHATSAPP_OWNER_DISPLAY: "Legacy WhatsApp Owner",
      TELEGRAM_OWNER_DISPLAY: "Legacy Telegram Owner",
      CUSTOM_SETTING: "preserved",
    });

    writeSetupEnv(".env.example", target, {
      MATTERMOST_OWNER_USER_ID: "abcdefghijklmnopqrstuvwxyz",
      DISCORD_OWNER_USER_ID: "111111111111111111",
      SLACK_OWNER_USER_ID: "UOWNER123",
      WHATSAPP_OWNER_JID: "6285878175157@s.whatsapp.net",
      TELEGRAM_OWNER_USER_ID: "42",
    }, existing);

    const contents = await fs.readFile(target, "utf8");
    expect(contents).toContain("MATTERMOST_OWNER_USER_ID=abcdefghijklmnopqrstuvwxyz");
    expect(contents).toContain("DISCORD_OWNER_USER_ID=111111111111111111");
    expect(contents).toContain("SLACK_OWNER_USER_ID=UOWNER123");
    expect(contents).toContain("WHATSAPP_OWNER_JID=6285878175157@s.whatsapp.net");
    expect(contents).toContain("TELEGRAM_OWNER_USER_ID=42");
    expect(contents).toContain("CUSTOM_SETTING=preserved");
    expect(contents).not.toMatch(/OWNER_(?:USERNAME|DISPLAY)=/);
  });

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
