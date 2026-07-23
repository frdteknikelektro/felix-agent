import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    WORKSPACE_DIR: "/test-workspace",
    SECRET_ENV_FILE: "/definitely/missing/felix-memory.env",
    ...overrides,
  };
}

describe("Memory configuration", () => {
  it("uses OWNER_TZ as the canonical timezone and keeps USAGE_TZ as fallback", () => {
    const canonical = loadConfig(env({
      OWNER_TZ: "Asia/Jakarta",
      USAGE_TZ: "America/New_York",
    }));
    expect(canonical.OWNER_TZ).toBe("Asia/Jakarta");

    const legacy = loadConfig(env({ USAGE_TZ: "Europe/London" }));
    expect(legacy.OWNER_TZ).toBe("Europe/London");

    const defaults = loadConfig(env());
    expect(defaults.OWNER_TZ).toBe("UTC");
  });

  it("rejects invalid Owner timezones", () => {
    expect(() => loadConfig(env({ OWNER_TZ: "not/a-zone" }))).toThrow();
    expect(() => loadConfig(env({ USAGE_TZ: "also-not-a-zone" }))).toThrow();
  });

  it("validates MEMORY_MAINTENANCE_CRON and defaults to 03:00", () => {
    expect(loadConfig(env()).MEMORY_MAINTENANCE_CRON).toBe("0 3 * * *");
    expect(
      loadConfig(env({ MEMORY_MAINTENANCE_CRON: "15 2 * * 1-5" }))
        .MEMORY_MAINTENANCE_CRON,
    ).toBe("15 2 * * 1-5");
    expect(() =>
      loadConfig(env({ MEMORY_MAINTENANCE_CRON: "not a cron" })),
    ).toThrow();
  });

  it("always provides a dedicated low-cost model and requires one for 9router", () => {
    const defaults = loadConfig(env());
    expect(defaults.CODEX_MODEL_FOR_MEMORIZING).toBe("gpt-5.4-mini");
    expect(defaults.OPENCODE_MODEL_FOR_MEMORIZING).toBe("opencode/deepseek-v4-flash-free");
    expect(defaults.CLAUDE_CODE_MODEL_FOR_MEMORIZING).toBe("haiku");

    expect(() => loadConfig(env({
      NINEROUTER_ENABLED: "true",
      NINEROUTER_KEY: "key",
      NINEROUTER_MODEL: "primary",
      NINEROUTER_URL: "https://router.example.com",
    }))).toThrow(/NINEROUTER_MODEL_FOR_MEMORIZING/);
  });
});
