import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FelixEngine } from "../src/engine.js";
import { startAppServer } from "../src/server/app.js";
import { requestApproval } from "../src/slices/approvals/index.js";
import { createOrLoadThread } from "../src/slices/sessions/index.js";
import { buildOwnerPermissionNotification } from "../src/core/harness-common.js";
import type { SourceAdapter } from "../src/core/ports.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { makeTestConfig, mattermostThreadRef } from "./helpers/workspace.js";

function makeNoopAdapter(): SourceAdapter {
  return {
    source: "mattermost",
    getThreadLink: async () => undefined,
    getTurnContext: async () => ({ behaviorInstructions: [], owner: { display: "Owner" } }),
    updateEventStatus: async () => undefined,
    sendTyping: async () => undefined,
    sendThreadReply: async () => undefined,
    sendUserMessage: async () => null,
    downloadAttachment: async (input) => input.attachment,
    formatOwnerNotification: async (input) => buildOwnerPermissionNotification(input),
  };
}

describe("owner web ui", () => {
  let server: Awaited<ReturnType<typeof startAppServer>> | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.server.close(() => resolve()));
      server = null;
    }
  });

  it("serves the SPA unauthenticated and gates the api + sse endpoints", async () => {
    const cfg = await makeTestConfig("felix-owner-ui-", {
      OWNER_UI_SECRET: "owner-secret",
    });

    const engine = new FelixEngine(cfg, [], new FakeHarness());
    await engine.boot();
    server = await startAppServer(cfg, engine, 0);

    const base = `http://localhost:${server.port}`;

    // The static SPA is served without auth (it contains its own login screen).
    // In the test environment web/dist is not built, so the server replies 503
    // rather than 401 — the point is that "/" is never auth-gated.
    const spa = await fetch(`${base}/`);
    expect(spa.status).not.toBe(401);
    expect([200, 503]).toContain(spa.status);

    // API + SSE are gated.
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/events/dashboard`)).status).toBe(401);

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ secret: "owner-secret" }),
    });
    expect(login.status).toBe(303);
    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain("felix_owner_session=");
    const cookie = setCookie!.split(";")[0]!;

    const sessions = await fetch(`${base}/api/sessions`, {
      headers: { cookie },
    });
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toEqual({ items: [] });
  });

  it("returns conflict when an approval action is already stale", async () => {
    const cfg = await makeTestConfig("felix-owner-ui-stale-", {
      OWNER_UI_SECRET: "owner-secret",
    });

    const engine = new FelixEngine(cfg, [makeNoopAdapter()], new FakeHarness());
    await engine.boot();
    server = await startAppServer(cfg, engine, 0);

    const thread = await createOrLoadThread(cfg, {
      source: "mattermost",
      thread_key: "mattermost:channel:stale",
      source_thread_ref: mattermostThreadRef("channel", "stale-root"),
      received_at: "2026-05-25T00:00:00.000Z",
    });
    await requestApproval(cfg, thread, {
      request_id: "req-stale",
      requested_at: "2026-05-25T00:00:00.000Z",
      skill_id: "deploy",
      permissions: ["shell.run"],
      reason: "ship it",
      owner_message: "please approve",
      thread_key: thread.state.thread_key,
      requester: { source: "mattermost", id: "user-1", display: "User One" },
      requester_event_file: path.join(thread.eventsDir, "req-stale.md"),
    });

    const base = `http://localhost:${server.port}`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ secret: "owner-secret" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const first = await fetch(`${base}/api/approvals/req-stale/approve`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ scope: "once" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/api/approvals/req-stale/approve`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ scope: "always" }),
    });
    expect(second.status).toBe(409);
  });
});
