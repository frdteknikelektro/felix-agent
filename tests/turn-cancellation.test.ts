import { describe, expect, it } from "vitest";
import { createTurnCancellation } from "../src/core/turn-cancellation.js";

describe("turn cancellation", () => {
  it("reports a request only after it is made and until it is cleared", () => {
    const c = createTurnCancellation();
    expect(c.isRequested("t1")).toBe(false);
    c.request("t1");
    expect(c.isRequested("t1")).toBe(true);
    c.clear("t1");
    expect(c.isRequested("t1")).toBe(false);
  });

  it("scopes requests per thread", () => {
    const c = createTurnCancellation();
    c.request("t1");
    expect(c.isRequested("t1")).toBe(true);
    expect(c.isRequested("t2")).toBe(false);
  });

  it("aborts the in-flight signal when a request lands mid-turn", () => {
    const c = createTurnCancellation();
    const signal = c.begin("t1");
    expect(signal.aborted).toBe(false);
    c.request("t1");
    expect(signal.aborted).toBe(true);
  });

  it("does not abort when no turn is in flight", () => {
    const c = createTurnCancellation();
    // request before begin: must not throw, and a later begin starts un-aborted
    c.request("t1");
    const signal = c.begin("t1");
    expect(signal.aborted).toBe(false);
  });

  it("end() drops the controller and clears the request flag", () => {
    const c = createTurnCancellation();
    const first = c.begin("t1");
    c.request("t1");
    expect(first.aborted).toBe(true);
    c.end("t1");
    expect(c.isRequested("t1")).toBe(false);
    // a subsequent request must not abort the previous (released) signal again
    const second = c.begin("t1");
    c.clear("t1");
    expect(second.aborted).toBe(false);
  });
});
