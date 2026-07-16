import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("FELIX_NAME config", () => {
  it("defaults to Felix for existing installations", () => {
    const cfg = loadConfig({
      WORKSPACE_DIR: "/tmp/felix-agent-name-default",
      SECRET_ENV_FILE: "/tmp/felix-agent-name-does-not-exist",
    });

    expect(cfg.FELIX_NAME).toBe("Felix");
  });

  it("loads a custom agent name", () => {
    const cfg = loadConfig({
      FELIX_NAME: "Nova",
      WORKSPACE_DIR: "/tmp/felix-agent-name-custom",
      SECRET_ENV_FILE: "/tmp/felix-agent-name-does-not-exist",
    });

    expect(cfg.FELIX_NAME).toBe("Nova");
    expect(cfg.MATTERMOST_BOT_DISPLAY).toBe("");
  });

  it("drops the removed WhatsApp-specific name override", () => {
    const cfg = loadConfig({
      FELIX_NAME: "Nova",
      WHATSAPP_BOT_NAME: "LegacyBot",
      WORKSPACE_DIR: "/tmp/felix-agent-name-legacy-whatsapp",
      SECRET_ENV_FILE: "/tmp/felix-agent-name-does-not-exist",
    });

    expect(cfg.FELIX_NAME).toBe("Nova");
    expect("WHATSAPP_BOT_NAME" in cfg).toBe(false);
  });

  it("defaults Telegram to polling and requires webhook credentials in webhook mode", () => {
    const polling = loadConfig({
      WORKSPACE_DIR: "/tmp/felix-telegram-polling",
      SECRET_ENV_FILE: "/tmp/felix-config-no-file",
    });
    expect(polling.TELEGRAM_MODE).toBe("polling");

    const clearedMode = loadConfig({
      TELEGRAM_MODE: "",
      WORKSPACE_DIR: "/tmp/felix-telegram-cleared-mode",
      SECRET_ENV_FILE: "/tmp/felix-config-no-file",
    });
    expect(clearedMode.TELEGRAM_MODE).toBe("polling");

    expect(() => loadConfig({
      TELEGRAM_MODE: "webhook",
      WORKSPACE_DIR: "/tmp/felix-telegram-webhook-invalid",
      SECRET_ENV_FILE: "/tmp/felix-config-no-file",
    })).toThrow(/TELEGRAM_WEBHOOK_URL|TELEGRAM_WEBHOOK_SECRET/);

    expect(() => loadConfig({
      TELEGRAM_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "http://example.com/webhooks/telegram",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      WORKSPACE_DIR: "/tmp/felix-telegram-http-webhook",
      SECRET_ENV_FILE: "/tmp/felix-config-no-file",
    })).toThrow(/HTTPS/);

    expect(() => loadConfig({
      TELEGRAM_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "not a url",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      WORKSPACE_DIR: "/tmp/felix-telegram-malformed-webhook",
      SECRET_ENV_FILE: "/tmp/felix-config-no-file",
    })).toThrow(/TELEGRAM_WEBHOOK_URL/);
  });
});
