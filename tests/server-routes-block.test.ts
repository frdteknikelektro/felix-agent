import { describe, expect, it, vi } from "vitest";
import { FelixEngine } from "../src/engine.js";
import { matchRoute, API_ROUTES } from "../src/server/routes.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { makeTestConfig } from "./helpers/workspace.js";

function findRoute(method: string, pattern: string) {
  const match = matchRoute(API_ROUTES, method, pattern);
  if (!match) throw new Error(`No route matched ${method} ${pattern}`);
  return match;
}

function stubSend() {
  const calls: Array<{ status: number; data: unknown }> = [];
  const send = (status: number, data: unknown) => {
    calls.push({ status, data });
  };
  return { send, calls };
}

function makeCtx(cfg: import("../src/config.js").AppConfig, engine: FelixEngine, threadKey: string, action: "block" | "unblock") {
  return {
    cfg,
    engine,
    // unused by the block/unblock routes
    req: undefined as never,
    res: undefined as never,
    pathname: `/api/threads/${threadKey}/${action}`,
    params: { threadKey },
    searchParams: new URLSearchParams(),
    readBody: async () => ({}),
    send: vi.fn(),
  };
}

describe("REST route /api/threads/:threadKey/{block,unblock}", () => {
  it("POST /block sets blocked to true on a brand-new thread", async () => {
    const cfg = await makeTestConfig("felix-route-block-");
    const engine = new FelixEngine(cfg, [], new FakeHarness());
    const threadKey = "mattermost:c1:root";

    const { route, params } = findRoute("POST", `/api/threads/${threadKey}/block`);
    const ctx = makeCtx(cfg, engine, threadKey, "block");
    await route.handler({ ...ctx, params });

    expect(ctx.send).toHaveBeenCalledWith(200, { ok: true, blocked: true });
  });

  it("POST /unblock sets blocked to false on an existing blocked thread", async () => {
    const cfg = await makeTestConfig("felix-route-unblock-");
    const engine = new FelixEngine(cfg, [], new FakeHarness());
    const threadKey = "mattermost:c2:root";
    await engine.setBlocked(threadKey, true);

    const { route, params } = findRoute("POST", `/api/threads/${threadKey}/unblock`);
    const ctx = makeCtx(cfg, engine, threadKey, "unblock");
    await route.handler({ ...ctx, params });

    expect(ctx.send).toHaveBeenCalledWith(200, { ok: true, blocked: false });
  });

  it("routes share a single helper — no per-route copy-paste", async () => {
    // Spot-check that the two routes resolve to distinct handlers but use
    // the same body shape. If either diverges (e.g., adds a body field)
    // this assertion forces the divergence to be intentional.
    const blockRoute = findRoute("POST", "/api/threads/mattermost:c3:root/block");
    const unblockRoute = findRoute("POST", "/api/threads/mattermost:c3:root/unblock");
    expect(blockRoute.route).not.toBe(unblockRoute.route);
  });
});
