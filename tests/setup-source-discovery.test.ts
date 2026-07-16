import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimTelegramOwner } from "../scripts/setup-source-discovery.mjs";

function telegramResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Telegram setup owner claim", () => {
  it("accepts only an exact claim code from a private human chat", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1) ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ method, body });

      if (method === "getWebhookInfo") return telegramResponse({ url: "" });
      if (requests.filter((request) => request.method === "getUpdates").length === 1) {
        return telegramResponse([
          {
            update_id: 10,
            message: {
              text: "felix-claim-correct",
              chat: { id: -100, type: "group" },
              from: { id: 42, is_bot: false, first_name: "Group User" },
            },
          },
          {
            update_id: 11,
            message: {
              text: "felix-claim-wrong",
              chat: { id: 42, type: "private" },
              from: { id: 42, is_bot: false, first_name: "Wrong Code" },
            },
          },
        ]);
      }

      if (requests.filter((request) => request.method === "getUpdates").length === 2) {
        return telegramResponse([
          {
            update_id: 12,
            message: {
              text: "felix-claim-correct",
              chat: { id: 42, type: "private" },
              from: { id: 42, is_bot: false, first_name: "Ada", last_name: "Lovelace" },
            },
          },
        ]);
      }

      return telegramResponse([
        {
          update_id: 13,
        },
      ]);
    });

    await expect(claimTelegramOwner({
      botToken: "123456:setup-secret",
      claimCode: "felix-claim-correct",
      fetchImpl,
      timeoutMs: 1_000,
    })).resolves.toEqual({
      userId: "42",
    });

    expect(requests.map((request) => request.method)).toEqual([
      "getWebhookInfo",
      "getUpdates",
      "getUpdates",
      "getUpdates",
    ]);
    expect(requests.at(-1)?.body).toMatchObject({
      offset: 13,
      limit: 1,
      timeout: 0,
    });
  });

  it("refuses to claim through a bot with an active webhook", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({
      url: "https://example.com/webhooks/telegram",
    }));

    await expect(claimTelegramOwner({
      botToken: "123456:setup-secret",
      claimCode: "felix-claim-code",
      fetchImpl,
      timeoutMs: 1_000,
    })).rejects.toThrow(/new or inactive bot/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled Bot API request at the claim deadline", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    ));

    await expect(claimTelegramOwner({
      botToken: "123456:setup-secret",
      claimCode: "felix-claim-code",
      fetchImpl,
      timeoutMs: 10,
    })).rejects.toThrow(/timed out/);
  });

  it("does not leak the bot token when Telegram rejects setup polling", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, description: "Unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));

    await expect(claimTelegramOwner({
      botToken: "123456:do-not-log-this",
      claimCode: "felix-claim-code",
      fetchImpl,
      timeoutMs: 1_000,
    })).rejects.not.toThrow(/123456:do-not-log-this/);
  });
});

describe("setup identity configuration surface", () => {
  it("does not expose the removed identity customizations", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    const setup = fs.readFileSync(path.join(root, "scripts/setup.mjs"), "utf8");

    expect(envExample).not.toMatch(/^MATTERMOST_OWNER_USERNAME=/m);
    expect(envExample).not.toMatch(/^MATTERMOST_OWNER_DISPLAY=/m);
    expect(envExample).not.toMatch(/^WHATSAPP_BOT_NAME=/m);
    expect(envExample).not.toMatch(/^TELEGRAM_OWNER_DISPLAY=/m);
    expect(setup).not.toContain("message: `MATTERMOST_OWNER_DISPLAY");
    expect(setup).not.toContain("message: `WHATSAPP_BOT_NAME");
    expect(setup).not.toContain("Keep the existing claimed Telegram owner?");
    expect(setup).toContain("claimTelegramOwner");
  });
});
