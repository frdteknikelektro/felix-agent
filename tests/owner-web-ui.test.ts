import { afterEach, describe, expect, it } from "vitest";
import { FelixEngine } from "../src/engine.js";
import { startAppServer } from "../src/server/app.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { makeTestConfig } from "./helpers/workspace.js";

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
});
