import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

const DEFAULT_TIMEOUT_MS = 120_000;
const DISCORD_DIRECT_MESSAGE_CHANNEL_TYPE = 1;
const MATTERMOST_USER_ID_PATTERN = /^[a-z0-9]{26}$/;
const MATTERMOST_USERNAME_PATTERN = /^(?=.*[a-z0-9])[a-z0-9._-]{1,64}$/;

function genericFailure() {
  return new Error("Owner discovery failed");
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(genericFailure()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function remainingTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

function deadlineSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function normalizeMattermostUsername(value) {
  const username = value.trim().replace(/^@+/, "").toLowerCase();
  if (!MATTERMOST_USERNAME_PATTERN.test(username)) throw genericFailure();
  return username;
}

function normalizeWhatsAppOwner(value) {
  const trimmed = value.trim();
  if (!/^\+?[\d\s()-]+$/.test(trimmed) || trimmed.startsWith("0")) throw genericFailure();
  const international = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  const phone = parsePhoneNumberFromString(international);
  if (!phone?.isPossible()) throw genericFailure();
  const digits = phone.number.slice(1);
  return `${digits}@s.whatsapp.net`;
}

function validateWhatsAppJid(value) {
  const trimmed = value.trim();
  if (!/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(trimmed)) throw genericFailure();
  return trimmed;
}

async function resolveMattermostOwner({ credentials, timeoutMs, prompts, dependencies }) {
  const username = normalizeMattermostUsername(await prompts.input({
    message: "Enter your Mattermost username:",
  }));
  const request = deadlineSignal(timeoutMs);
  try {
    const baseUrl = String(credentials.baseUrl ?? "").replace(/\/+$/, "");
    const response = await (dependencies.fetchImpl ?? fetch)(
      `${baseUrl}/api/v4/users/username/${encodeURIComponent(username)}`,
      {
        headers: { Authorization: `Bearer ${credentials.botToken}` },
        signal: request.signal,
      },
    );
    if (!response.ok) throw genericFailure();
    const user = await response.json();
    if (
      typeof user?.id !== "string"
      || !MATTERMOST_USER_ID_PATTERN.test(user.id)
      || Number(user.delete_at ?? 0) > 0
      || user.is_bot === true
    ) {
      throw genericFailure();
    }
    await prompts.showConfirmation?.({ source: "mattermost" });
    return { userId: user.id, method: "lookup" };
  } catch {
    throw genericFailure();
  } finally {
    request.clear();
  }
}

async function resolveWhatsAppOwner({ prompts }) {
  const phone = await prompts.input({
    message: "Enter your WhatsApp phone number with country code:",
  });
  return {
    userId: normalizeWhatsAppOwner(phone),
    method: "phone",
  };
}

function claimCode(dependencies) {
  const bytes = (dependencies.randomBytes ?? cryptoRandomBytes)(12);
  return Promise.resolve(bytes).then((value) => `felix-claim-${Buffer.from(value).toString("base64url")}`);
}

async function defaultCreateDiscordClient(options) {
  const { Client, GatewayIntentBits, Partials } = await import("discord.js");
  const intents = options.intents.map((intent) => GatewayIntentBits[intent]);
  const partials = options.partials.map((partial) => Partials[partial]);
  return new Client({ intents, partials });
}

async function resolveDiscordOwner({ credentials, timeoutMs, prompts, dependencies }) {
  const deadline = Date.now() + timeoutMs;
  const code = await claimCode(dependencies);
  const client = await withTimeout(
    () => (dependencies.createDiscordClient ?? defaultCreateDiscordClient)({
      intents: ["DirectMessages"],
      partials: ["Channel"],
    }),
    remainingTimeout(deadline),
  );
  let settle;
  let settled = false;
  const claimed = new Promise((resolve) => {
    settle = resolve;
  });
  const handler = (message) => {
    const attachmentCount = Number(message?.attachments?.size ?? message?.attachments?.length ?? 0);
    if (
      settled
      || message?.guildId != null
      || message?.channel?.type !== DISCORD_DIRECT_MESSAGE_CHANNEL_TYPE
      || message?.author?.bot === true
      || !message?.author?.id
      || message.author.id === client.user?.id
      || attachmentCount > 0
      || typeof message?.content !== "string"
      || message.content !== code
    ) {
      return;
    }
    settled = true;
    settle(String(message.author.id));
  };

  client.on("messageCreate", handler);
  try {
    await prompts.showClaim({ source: "discord", claimCode: code });
    const userId = await withTimeout(async () => {
      await client.login(credentials.botToken);
      return claimed;
    }, remainingTimeout(deadline));
    return { userId, method: "claim" };
  } catch {
    throw genericFailure();
  } finally {
    try {
      client.off("messageCreate", handler);
      await client.destroy();
    } catch {}
  }
}

async function defaultCreateSlackApp(options) {
  const { App } = await import("@slack/bolt");
  return new App(options);
}

async function resolveSlackOwner({ credentials, timeoutMs, prompts, dependencies }) {
  const deadline = Date.now() + timeoutMs;
  const code = await claimCode(dependencies);
  const app = await withTimeout(
    () => (dependencies.createSlackApp ?? defaultCreateSlackApp)({
      token: credentials.botToken,
      appToken: credentials.appToken,
      socketMode: true,
    }),
    remainingTimeout(deadline),
  );
  let settle;
  let settled = false;
  const claimed = new Promise((resolve) => {
    settle = resolve;
  });
  let botUserId;
  app.event("message", async ({ event }) => {
    const files = Array.isArray(event?.files) ? event.files : [];
    if (
      settled
      || event?.channel_type !== "im"
      || event?.subtype
      || event?.bot_id
      || !event?.user
      || event.user === botUserId
      || files.length > 0
      || typeof event?.text !== "string"
      || event.text !== code
    ) {
      return;
    }
    settled = true;
    settle(String(event.user));
  });
  app.error(async () => {});

  try {
    await prompts.showClaim({ source: "slack", claimCode: code });
    const userId = await withTimeout(async () => {
      const auth = await app.client.auth.test();
      botUserId = auth.user_id;
      await app.start();
      return claimed;
    }, remainingTimeout(deadline));
    return { userId, method: "claim" };
  } catch {
    throw genericFailure();
  } finally {
    try {
      await app.stop();
    } catch {}
  }
}

async function telegramRequest(botToken, method, body, fetchImpl, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw genericFailure();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw genericFailure();
    return payload.result;
  } catch {
    throw genericFailure();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTelegramOwner({ credentials, timeoutMs, prompts, dependencies }) {
  const botToken = String(credentials.botToken ?? "");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw genericFailure();
  const code = await claimCode(dependencies);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;

  try {
    const webhookInfo = await telegramRequest(botToken, "getWebhookInfo", {}, fetchImpl, deadline);
    if (typeof webhookInfo?.url === "string" && webhookInfo.url !== "") {
      throw genericFailure();
    }
    await prompts.showClaim({ source: "telegram", claimCode: code });

    let offset;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const updates = await telegramRequest(botToken, "getUpdates", {
        ...(offset === undefined ? {} : { offset }),
        timeout: Math.max(1, Math.min(10, Math.ceil(remainingMs / 1_000))),
        allowed_updates: ["message"],
      }, fetchImpl, deadline);
      if (!Array.isArray(updates)) throw genericFailure();

      for (const update of updates) {
        if (Number.isSafeInteger(update?.update_id)) {
          offset = Math.max(offset ?? 0, update.update_id + 1);
        }
        const message = update?.message;
        const sender = message?.from;
        const chat = message?.chat;
        if (
          message?.text !== code
          || chat?.type !== "private"
          || sender?.is_bot === true
          || !Number.isSafeInteger(sender?.id)
          || sender.id !== chat?.id
        ) {
          continue;
        }
        await telegramRequest(botToken, "getUpdates", {
          offset: update.update_id + 1,
          limit: 1,
          timeout: 0,
          allowed_updates: ["message"],
        }, fetchImpl, deadline);
        return { userId: String(sender.id), method: "claim" };
      }
    }
    throw genericFailure();
  } catch {
    throw genericFailure();
  }
}

function validatePattern(pattern) {
  return (value) => {
    const trimmed = value.trim();
    if (!pattern.test(trimmed)) throw genericFailure();
    return trimmed;
  };
}

const SOURCE_STRATEGIES = {
  mattermost: {
    resolve: resolveMattermostOwner,
    manualLabel: "Mattermost user ID",
    manualValue: validatePattern(MATTERMOST_USER_ID_PATTERN),
  },
  discord: {
    resolve: resolveDiscordOwner,
    manualLabel: "Discord user ID",
    manualValue: validatePattern(/^\d{17,20}$/),
  },
  slack: {
    resolve: resolveSlackOwner,
    manualLabel: "Slack member ID",
    manualValue: validatePattern(/^[UW][A-Z0-9]{8,}$/),
  },
  whatsapp: {
    resolve: resolveWhatsAppOwner,
    manualLabel: "WhatsApp JID",
    manualValue: validateWhatsAppJid,
  },
  telegram: {
    resolve: resolveTelegramOwner,
    manualLabel: "Telegram numeric user ID",
    manualValue: validatePattern(/^\d{1,20}$/),
  },
};

function sourceStrategy(source) {
  const strategy = SOURCE_STRATEGIES[source];
  if (!strategy) throw genericFailure();
  return strategy;
}

function manualIdForSource(source, value) {
  return sourceStrategy(source).manualValue(value);
}

function manualPrompt(source) {
  return `Enter the ${sourceStrategy(source).manualLabel}:`;
}

async function resolveAutomaticOwner(options) {
  const { source, ...resolverOptions } = options;
  return sourceStrategy(source).resolve(resolverOptions);
}

export async function resolveSetupOwner({
  source,
  credentials,
  existingOwnerId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  prompts,
  dependencies = {},
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw genericFailure();
  if (existingOwnerId && (!prompts.confirmExisting || await prompts.confirmExisting({ source }))) {
    return { userId: existingOwnerId, method: "preserved" };
  }

  while (true) {
    try {
      return await resolveAutomaticOwner({
        source,
        credentials,
        timeoutMs,
        prompts,
        dependencies,
      });
    } catch {
      const action = await prompts.select({
        message: "Automatic owner discovery did not complete. What would you like to do?",
        choices: [
          { value: "retry", name: "Try automatic discovery again" },
          { value: "manual", name: "Enter the platform ID manually" },
          { value: "cancel", name: "Cancel setup" },
        ],
        default: "retry",
      });
      if (action === "retry") continue;
      if (action === "manual") {
        const value = await prompts.input({
          message: manualPrompt(source),
          validate: (candidate) => {
            try {
              manualIdForSource(source, candidate);
              return true;
            } catch {
              return "Enter a valid platform identifier";
            }
          },
        });
        return {
          userId: manualIdForSource(source, value),
          method: "manual",
        };
      }
      const error = new Error("Owner discovery cancelled");
      error.name = "SetupOwnerDiscoveryCancelledError";
      throw error;
    }
  }
}
