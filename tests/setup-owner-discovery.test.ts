import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSetupOwner } from "../scripts/setup-owner-discovery.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@inquirer/prompts");
  delete process.env.FELIX_SETUP_ENV_FILE;
});

function makePrompts(inputValues: string[] = [], selectValues: string[] = []) {
  return {
    input: vi.fn(async () => inputValues.shift() ?? ""),
    select: vi.fn(async () => selectValues.shift() ?? "cancel"),
    showClaim: vi.fn(),
    showConfirmation: vi.fn(),
    confirmExisting: vi.fn(async () => true),
  };
}

function telegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveSetupOwner", () => {
  it("preserves an existing owner ID without connecting to the source", async () => {
    const fetchImpl = vi.fn();

    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com",
        botToken: "secret-token",
      },
      existingOwnerId: "existing-owner-id",
      prompts: makePrompts(),
      dependencies: { fetchImpl },
    })).resolves.toEqual({
      userId: "existing-owner-id",
      method: "preserved",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("changes an existing owner only after an explicit setup choice", async () => {
    const prompts = makePrompts(["ada"]);
    prompts.confirmExisting.mockResolvedValue(false);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "bcdefghijklmnopqrstuvwxyza",
      username: "ada",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com",
        botToken: "secret-token",
      },
      existingOwnerId: "existing-owner-id",
      prompts,
      dependencies: { fetchImpl },
    })).resolves.toEqual({
      userId: "bcdefghijklmnopqrstuvwxyza",
      method: "lookup",
    });
  });

  it("resolves a Mattermost username with or without @ and stores only its stable user ID", async () => {
    const prompts = makePrompts(["@Ada.Lovelace"]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "abcdefghijklmnopqrstuvwxyz",
      username: "ada.lovelace",
      delete_at: 0,
      is_bot: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com/",
        botToken: "secret-token",
      },
      prompts,
      dependencies: { fetchImpl },
    })).resolves.toEqual({
      userId: "abcdefghijklmnopqrstuvwxyz",
      method: "lookup",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mattermost.example.com/api/v4/users/username/ada.lovelace",
      expect.objectContaining({
        headers: { Authorization: "Bearer secret-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(prompts.showConfirmation).toHaveBeenCalledWith({
      source: "mattermost",
    });
  });

  it.each([
    { id: "abcdefghijklmnopqrstuvwxy1", username: "deleted", delete_at: 1, is_bot: false },
    { id: "abcdefghijklmnopqrstuvwxy2", username: "helperbot", delete_at: 0, is_bot: true },
    { username: "missing-id", delete_at: 0, is_bot: false },
    { id: "malformed-id", username: "malformed", delete_at: 0, is_bot: false },
  ])("rejects an unusable Mattermost account without exposing response data", async (account) => {
    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com",
        botToken: "secret-token",
      },
      prompts: makePrompts([account.username], ["cancel"]),
      dependencies: {
        fetchImpl: async () => new Response(JSON.stringify(account), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      },
    })).rejects.toThrow("Owner discovery cancelled");
  });

  it.each([
    "ada lovelace",
    "ada/lovelace",
    "ada%2Flovelace",
    ".",
    "a".repeat(65),
  ])("rejects malformed Mattermost usernames without making a request: %j", async (username) => {
    const fetchImpl = vi.fn();
    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com",
        botToken: "secret-token",
      },
      prompts: makePrompts([username], ["cancel"]),
      dependencies: { fetchImpl },
    })).rejects.toThrow("Owner discovery cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes a formatted WhatsApp phone number into a stable JID", async () => {
    await expect(resolveSetupOwner({
      source: "whatsapp",
      credentials: {},
      prompts: makePrompts(["+62 (858) 7817-5157"]),
    })).resolves.toEqual({
      userId: "6285878175157@s.whatsapp.net",
      method: "phone",
    });
  });

  it("claims a Discord owner from an exact human DM and always destroys the client", async () => {
    const emitter = new EventEmitter();
    const destroy = vi.fn();
    const createDiscordClient = vi.fn(async (options: unknown) => ({
      user: { id: "999999999999999999" },
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      login: vi.fn(async () => {
        queueMicrotask(() => {
          emitter.emit("messageCreate", {
            content: "felix-claim-wrong",
            guildId: null,
            channel: { type: 1 },
            author: { id: "111111111111111111", bot: false },
            attachments: { size: 0 },
          });
          emitter.emit("messageCreate", {
            content: "felix-claim-Y2xhaW0",
            guildId: "guild-id",
            channel: { type: 0 },
            author: { id: "222222222222222222", bot: false },
            attachments: { size: 0 },
          });
          emitter.emit("messageCreate", {
            content: "felix-claim-Y2xhaW0",
            guildId: null,
            channel: { type: 3 },
            author: { id: "666666666666666666", bot: false },
            attachments: { size: 0 },
          });
          emitter.emit("messageCreate", {
            content: "felix-claim-Y2xhaW0",
            guildId: null,
            channel: { type: 1 },
            author: { id: "444444444444444444", bot: true },
            attachments: { size: 0 },
          });
          emitter.emit("messageCreate", {
            content: "felix-claim-Y2xhaW0",
            guildId: null,
            channel: { type: 1 },
            author: { id: "999999999999999999", bot: false },
            attachments: { size: 0 },
          });
          emitter.emit("messageCreate", {
            content: "felix-claim-Y2xhaW0",
            guildId: null,
            channel: { type: 1 },
            author: { id: "555555555555555555", bot: false },
            attachments: { size: 1 },
          });
          emitter.emit("messageCreate", {
            content: " felix-claim-Y2xhaW0 ",
            guildId: null,
            channel: { type: 1 },
            author: { id: "777777777777777777", bot: false },
            attachments: { size: 0 },
          });
          emitter.emit("messageCreate", {
            content: "felix-claim-Y2xhaW0",
            guildId: null,
            channel: { type: 1 },
            author: { id: "333333333333333333", bot: false },
            attachments: { size: 0 },
          });
          emitter.emit("messageCreate", {
            content: "felix-claim-Y2xhaW0",
            guildId: null,
            channel: { type: 1 },
            author: { id: "888888888888888888", bot: false },
            attachments: { size: 0 },
          });
        });
      }),
      destroy,
    }));
    const prompts = makePrompts();

    await expect(resolveSetupOwner({
      source: "discord",
      credentials: { botToken: "discord-secret" },
      prompts,
      dependencies: {
        createDiscordClient,
        randomBytes: () => Buffer.from("claim"),
      },
    })).resolves.toEqual({
      userId: "333333333333333333",
      method: "claim",
    });

    expect(createDiscordClient).toHaveBeenCalledWith({
      intents: ["DirectMessages"],
      partials: ["Channel"],
    });
    expect(prompts.showClaim).toHaveBeenCalledWith({
      source: "discord",
      claimCode: "felix-claim-Y2xhaW0",
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("claims a Slack owner from an exact one-to-one DM and always stops the app", async () => {
    let messageHandler: ((input: { event: Record<string, unknown> }) => Promise<void>) | undefined;
    const stop = vi.fn(async () => {});
    const createSlackApp = vi.fn(async () => ({
      client: {
        auth: {
          test: vi.fn(async () => ({ user_id: "USLACKBOT" })),
        },
      },
      event: vi.fn((name: string, handler: typeof messageHandler) => {
        if (name === "message") messageHandler = handler;
      }),
      error: vi.fn(),
      start: vi.fn(async () => {
        await messageHandler?.({
          event: {
            text: "felix-claim-Y2xhaW0",
            channel: "CCHANNEL",
            channel_type: "channel",
            user: "UCHANNELUSER",
          },
        });
        await messageHandler?.({
          event: {
            text: "felix-claim-Y2xhaW0",
            channel: "DBOT",
            channel_type: "im",
            user: "UBOT",
            bot_id: "BBOT",
          },
        });
        await messageHandler?.({
          event: {
            text: "felix-claim-Y2xhaW0",
            channel: "DSELF",
            channel_type: "im",
            user: "USLACKBOT",
          },
        });
        await messageHandler?.({
          event: {
            text: " felix-claim-Y2xhaW0 ",
            channel: "DWHITESPACE",
            channel_type: "im",
            user: "UWHITESPACE",
          },
        });
        await messageHandler?.({
          event: {
            text: "felix-claim-Y2xhaW0",
            channel: "DEDITED",
            channel_type: "im",
            user: "UEDITED",
            subtype: "message_changed",
          },
        });
        await messageHandler?.({
          event: {
            text: "felix-claim-Y2xhaW0",
            channel: "DFILE",
            channel_type: "im",
            user: "UFILE",
            files: [{ id: "F1" }],
          },
        });
        await messageHandler?.({
          event: {
            text: "felix-claim-Y2xhaW0",
            channel: "DOWNER",
            channel_type: "im",
            user: "UOWNER123",
          },
        });
        await messageHandler?.({
          event: {
            text: "felix-claim-Y2xhaW0",
            channel: "DSECOND",
            channel_type: "im",
            user: "USECOND123",
          },
        });
      }),
      stop,
    }));

    await expect(resolveSetupOwner({
      source: "slack",
      credentials: {
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      },
      prompts: makePrompts(),
      dependencies: {
        createSlackApp,
        randomBytes: () => Buffer.from("claim"),
      },
    })).resolves.toEqual({
      userId: "UOWNER123",
      method: "claim",
    });

    expect(createSlackApp).toHaveBeenCalledWith({
      token: "xoxb-secret",
      appToken: "xapp-secret",
      socketMode: true,
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("claims a Telegram owner through the shared interface", async () => {
    let updateCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "getWebhookInfo") return telegramResponse({ url: "" });
      updateCalls += 1;
      if (updateCalls === 1) {
        return telegramResponse([{
          update_id: 10,
          message: {
            text: "felix-claim-wrong",
            chat: { id: 42, type: "private" },
            from: { id: 42, is_bot: false },
          },
        }]);
      }
      if (updateCalls === 2) {
        return telegramResponse([{
          update_id: 11,
          message: {
            text: "felix-claim-Y2xhaW0",
            chat: { id: 42, type: "private" },
            from: { id: 42, is_bot: false },
          },
        }]);
      }
      return telegramResponse([]);
    });

    await expect(resolveSetupOwner({
      source: "telegram",
      credentials: { botToken: "123456:telegram-secret" },
      prompts: makePrompts(),
      dependencies: {
        fetchImpl,
        randomBytes: () => Buffer.from("claim"),
      },
      timeoutMs: 1_000,
    })).resolves.toEqual({
      userId: "42",
      method: "claim",
    });
  });

  it("offers validated manual ID entry only after automatic discovery fails", async () => {
    const prompts = makePrompts(
      ["missing-user", "abcdefghijklmnopqrstuvwxyz"],
      ["manual"],
    );
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));

    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com",
        botToken: "secret-token",
      },
      prompts,
      dependencies: { fetchImpl },
    })).resolves.toEqual({
      userId: "abcdefghijklmnopqrstuvwxyz",
      method: "manual",
    });

    expect(prompts.select).toHaveBeenCalledOnce();
    expect(prompts.input).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      source: "discord",
      credentials: { botToken: "discord-secret" },
      inputValues: ["111111111111111111"],
      dependencies: { createDiscordClient: async () => { throw new Error("unavailable"); } },
      userId: "111111111111111111",
    },
    {
      source: "slack",
      credentials: { botToken: "xoxb-secret", appToken: "xapp-secret" },
      inputValues: ["UOWNER123"],
      dependencies: { createSlackApp: async () => { throw new Error("unavailable"); } },
      userId: "UOWNER123",
    },
    {
      source: "whatsapp",
      credentials: {},
      inputValues: ["invalid phone", "6285878175157@s.whatsapp.net"],
      dependencies: {},
      userId: "6285878175157@s.whatsapp.net",
    },
    {
      source: "telegram",
      credentials: { botToken: "invalid-token" },
      inputValues: ["42"],
      dependencies: {},
      userId: "42",
    },
  ] as const)("validates the $source manual stable identifier after automatic failure", async ({
    source,
    credentials,
    inputValues,
    dependencies,
    userId,
  }) => {
    await expect(resolveSetupOwner({
      source,
      credentials,
      prompts: makePrompts([...inputValues], ["manual"]),
      dependencies,
    })).resolves.toEqual({
      userId,
      method: "manual",
    });
  });

  it("leaves an existing environment file unchanged when owner discovery is cancelled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "felix-owner-cancel-"));
    const envPath = path.join(dir, ".env");
    const original = "FELIX_NAME=Existing\nMATTERMOST_OWNER_USER_ID=abcdefghijklmnopqrstuvwxyz\n";
    fs.writeFileSync(envPath, original, { mode: 0o600 });

    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com",
        botToken: "secret-token",
      },
      prompts: makePrompts(["missing-user"], ["cancel"]),
      dependencies: {
        fetchImpl: async () => new Response("not found", { status: 404 }),
      },
    })).rejects.toMatchObject({
      name: "SetupOwnerDiscoveryCancelledError",
      message: "Owner discovery cancelled",
    });

    expect(fs.readFileSync(envPath, "utf8")).toBe(original);
  });

  it("runs the setup wizard through owner cancellation without replacing FELIX_SETUP_ENV_FILE", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "felix-setup-cancel-"));
    const envPath = path.join(dir, ".env");
    const original = [
      "FELIX_NAME=Existing",
      "HARNESS=codex",
      "OPENAI_API_KEY=existing-openai-key",
      "OWNER_UI_SECRET=existing-owner-secret-1234567890",
      "DB_ENCRYPTION_KEY=existing-database-key",
      "MATTERMOST_URL=https://mattermost.example.com",
      "MATTERMOST_BOT_TOKEN=existing-mattermost-token",
      "",
    ].join("\n");
    fs.writeFileSync(envPath, original, { mode: 0o600 });
    process.env.FELIX_SETUP_ENV_FILE = envPath;

    const input = vi.fn(async (options: { message: string; default?: string }) => {
      if (options.message.includes("Enter your Mattermost username")) return "missing-user";
      if (options.message.includes("OPENAI_API_KEY")) return "existing-openai-key";
      if (options.message.includes("MATTERMOST_URL")) return "https://mattermost.example.com";
      if (options.message.includes("MATTERMOST_BOT_TOKEN")) return "existing-mattermost-token";
      return options.default ?? "";
    });
    const select = vi.fn(async (options: { message: string }) => {
      if (options.message.includes("Select LLM backend")) return "codex";
      if (options.message.includes("Codex authentication method")) return "api-key";
      if (options.message.includes("Automatic owner discovery")) return "cancel";
      throw new Error(`Unexpected select prompt: ${options.message}`);
    });
    const confirm = vi.fn(async (options: { message: string }) => {
      if (options.message.includes("Enable 9router")) return false;
      throw new Error(`Unexpected confirm prompt: ${options.message}`);
    });
    const checkbox = vi.fn(async () => ["mattermost"]);

    vi.resetModules();
    vi.doMock("@inquirer/prompts", () => ({
      input,
      select,
      confirm,
      checkbox,
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    const { main } = await import("../scripts/setup.mjs");
    await main();

    expect(fs.readFileSync(envPath, "utf8")).toBe(original);
    expect(fs.readdirSync(dir)).toEqual([".env"]);
  });

  it("times out a stalled Discord connection and still destroys the client", async () => {
    const destroy = vi.fn();
    const emitter = new EventEmitter();

    await expect(resolveSetupOwner({
      source: "discord",
      credentials: { botToken: "discord-secret" },
      prompts: makePrompts([], ["cancel"]),
      dependencies: {
        createDiscordClient: async () => ({
          user: null,
          on: emitter.on.bind(emitter),
          off: emitter.off.bind(emitter),
          login: async () => await new Promise(() => {}),
          destroy,
        }),
        randomBytes: () => Buffer.from("claim"),
      },
      timeoutMs: 10,
    })).rejects.toThrow("Owner discovery cancelled");

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys the Discord client and removes its listener after login failure", async () => {
    const destroy = vi.fn();
    const emitter = new EventEmitter();

    await expect(resolveSetupOwner({
      source: "discord",
      credentials: { botToken: "discord-secret" },
      prompts: makePrompts([], ["cancel"]),
      dependencies: {
        createDiscordClient: async () => ({
          user: null,
          on: emitter.on.bind(emitter),
          off: emitter.off.bind(emitter),
          login: async () => { throw new Error("login failed"); },
          destroy,
        }),
        randomBytes: () => Buffer.from("claim"),
      },
    })).rejects.toThrow("Owner discovery cancelled");

    expect(destroy).toHaveBeenCalledOnce();
    expect(emitter.listenerCount("messageCreate")).toBe(0);
  });

  it("destroys the Discord client when claim display is cancelled", async () => {
    const destroy = vi.fn();
    const emitter = new EventEmitter();
    const prompts = makePrompts([], ["cancel"]);
    prompts.showClaim.mockRejectedValue(new Error("cancelled"));

    await expect(resolveSetupOwner({
      source: "discord",
      credentials: { botToken: "discord-secret" },
      prompts,
      dependencies: {
        createDiscordClient: async () => ({
          user: null,
          on: emitter.on.bind(emitter),
          off: emitter.off.bind(emitter),
          login: vi.fn(),
          destroy,
        }),
        randomBytes: () => Buffer.from("claim"),
      },
    })).rejects.toThrow("Owner discovery cancelled");

    expect(destroy).toHaveBeenCalledOnce();
    expect(emitter.listenerCount("messageCreate")).toBe(0);
  });

  it("stops a stalled Slack app after the deadline", async () => {
    const stop = vi.fn(async () => {});

    await expect(resolveSetupOwner({
      source: "slack",
      credentials: {
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      },
      prompts: makePrompts([], ["cancel"]),
      dependencies: {
        createSlackApp: async () => ({
          client: { auth: { test: async () => await new Promise(() => {}) } },
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn(),
          stop,
        }),
        randomBytes: () => Buffer.from("claim"),
      },
      timeoutMs: 10,
    })).rejects.toThrow("Owner discovery cancelled");

    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the Slack app after startup failure", async () => {
    const stop = vi.fn(async () => {});

    await expect(resolveSetupOwner({
      source: "slack",
      credentials: {
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      },
      prompts: makePrompts([], ["cancel"]),
      dependencies: {
        createSlackApp: async () => ({
          client: { auth: { test: async () => ({ user_id: "USLACKBOT" }) } },
          event: vi.fn(),
          error: vi.fn(),
          start: async () => { throw new Error("start failed"); },
          stop,
        }),
        randomBytes: () => Buffer.from("claim"),
      },
    })).rejects.toThrow("Owner discovery cancelled");

    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the Slack app when claim display is cancelled", async () => {
    const stop = vi.fn(async () => {});
    const prompts = makePrompts([], ["cancel"]);
    prompts.showClaim.mockRejectedValue(new Error("cancelled"));

    await expect(resolveSetupOwner({
      source: "slack",
      credentials: {
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      },
      prompts,
      dependencies: {
        createSlackApp: async () => ({
          client: { auth: { test: vi.fn() } },
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn(),
          stop,
        }),
        randomBytes: () => Buffer.from("claim"),
      },
    })).rejects.toThrow("Owner discovery cancelled");

    expect(stop).toHaveBeenCalledOnce();
  });

  it("refuses to take over a Telegram bot with an active webhook", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({
      url: "https://example.com/webhooks/telegram",
    }));

    await expect(resolveSetupOwner({
      source: "telegram",
      credentials: { botToken: "123456:telegram-secret" },
      prompts: makePrompts([], ["cancel"]),
      dependencies: {
        fetchImpl,
        randomBytes: () => Buffer.from("claim"),
      },
    })).rejects.toThrow("Owner discovery cancelled");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("aborts a stalled Telegram request at the deadline", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    ));

    await expect(resolveSetupOwner({
      source: "telegram",
      credentials: { botToken: "123456:telegram-secret" },
      prompts: makePrompts([], ["cancel"]),
      dependencies: {
        fetchImpl,
        randomBytes: () => Buffer.from("claim"),
      },
      timeoutMs: 10,
    })).rejects.toThrow("Owner discovery cancelled");
  });

  it.each([
    "",
    "085878175157",
    "85878175157",
    "1234",
    "1234567890123456",
    "+62 owner",
  ])("rejects an invalid WhatsApp owner phone without echoing it: %j", async (phone) => {
    await expect(resolveSetupOwner({
      source: "whatsapp",
      credentials: {},
      prompts: makePrompts([phone], ["cancel"]),
    })).rejects.toThrow("Owner discovery cancelled");
  });

  it("retries automatic discovery with a new user input", async () => {
    const prompts = makePrompts(["missing-user", "ada"], ["retry"]);
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({
        id: "abcdefghijklmnopqrstuvwxyz",
        username: "ada",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(resolveSetupOwner({
      source: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.com",
        botToken: "secret-token",
      },
      prompts,
      dependencies: { fetchImpl },
    })).resolves.toEqual({
      userId: "abcdefghijklmnopqrstuvwxyz",
      method: "lookup",
    });
  });

  it("keeps setup-facing configuration limited to stable owner identifiers", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    const setup = fs.readFileSync(path.join(root, "scripts/setup.mjs"), "utf8");

    expect(envExample).not.toMatch(/^(?:MATTERMOST|DISCORD|SLACK|WHATSAPP|TELEGRAM)_OWNER_DISPLAY=/m);
    expect(envExample).not.toMatch(/^MATTERMOST_OWNER_USERNAME=/m);
    expect(setup).not.toContain("message: `DISCORD_OWNER_USER_ID");
    expect(setup).not.toContain("message: `SLACK_OWNER_USER_ID");
    expect(setup).not.toContain("message: `WHATSAPP_OWNER_DISPLAY");
    expect(setup).toContain("resolveSetupOwner");
  });
});
