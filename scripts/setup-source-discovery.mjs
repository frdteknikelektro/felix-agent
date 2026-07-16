const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LONG_POLL_SECONDS = 10;

function telegramApiUrl(botToken, method) {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

async function telegramRequest(botToken, method, body, fetchImpl, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Telegram owner claim timed out");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  let response;
  let payload;
  try {
    response = await fetchImpl(telegramApiUrl(botToken, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    payload = await response.json();
  } catch {
    if (controller.signal.aborted) {
      throw new Error("Telegram owner claim timed out");
    }
    throw new Error(`Telegram owner claim received no valid ${method} response`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Telegram owner claim ${method} failed (HTTP ${response.status})`);
  }
  return payload.result;
}

function ownerFromUpdate(update, claimCode) {
  const message = update?.message;
  const sender = message?.from;
  const chat = message?.chat;
  if (
    message?.text !== claimCode
    || chat?.type !== "private"
    || sender?.is_bot === true
    || !Number.isSafeInteger(sender?.id)
    || sender.id !== chat?.id
  ) {
    return undefined;
  }

  return {
    userId: String(sender.id),
  };
}

export async function claimTelegramOwner({
  botToken,
  claimCode,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof botToken !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    throw new Error("Telegram owner claim requires a valid bot token");
  }
  if (typeof claimCode !== "string" || claimCode.trim() === "") {
    throw new Error("Telegram owner claim requires a claim code");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Telegram owner claim timeout must be positive");
  }

  const deadline = Date.now() + timeoutMs;
  const webhookInfo = await telegramRequest(botToken, "getWebhookInfo", {}, fetchImpl, deadline);
  if (typeof webhookInfo?.url === "string" && webhookInfo.url !== "") {
    throw new Error("Telegram owner claim requires a new or inactive bot with no registered webhook");
  }

  let offset;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const pollSeconds = Math.max(1, Math.min(
      MAX_LONG_POLL_SECONDS,
      Math.ceil(remainingMs / 1_000),
    ));
    const result = await telegramRequest(botToken, "getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      timeout: pollSeconds,
      allowed_updates: ["message"],
    }, fetchImpl, deadline);
    if (!Array.isArray(result)) {
      throw new Error("Telegram owner claim received an invalid getUpdates result");
    }

    for (const update of result) {
      if (Number.isSafeInteger(update?.update_id)) {
        offset = Math.max(offset ?? 0, update.update_id + 1);
      }
      const owner = ownerFromUpdate(update, claimCode);
      if (owner) {
        await telegramRequest(botToken, "getUpdates", {
          offset: update.update_id + 1,
          limit: 1,
          timeout: 0,
          allowed_updates: ["message"],
        }, fetchImpl, deadline);
        return owner;
      }
    }
  }

  throw new Error("Telegram owner claim timed out before the matching private message arrived");
}
