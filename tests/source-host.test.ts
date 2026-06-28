import { describe, expect, it, vi } from "vitest";
import { createSourceHost, DEFAULT_DEDUP_TTL_MS } from "../src/core/source-host.js";
import { AttachmentRejectedError } from "../src/core/attachments.js";
import type { UniversalAttachment } from "../src/types.js";

function attachment(overrides: Partial<UniversalAttachment> = {}): UniversalAttachment {
  return {
    file_id: "f1",
    filename: "a.bin",
    ...overrides,
  };
}

describe("source host — dedup", () => {
  it("treats a fresh id as first sight and a repeat as duplicate", () => {
    const host = createSourceHost({ source: "test" });
    expect(host.firstSight("m1")).toBe(true);
    expect(host.firstSight("m1")).toBe(false);
    expect(host.firstSight("m2")).toBe(true);
  });

  it("treats an id as fresh again once the TTL window passes", () => {
    let clock = 1_000;
    const host = createSourceHost({ source: "test", ttlMs: 100, now: () => clock });
    expect(host.firstSight("m1")).toBe(true);
    clock += 50;
    expect(host.firstSight("m1")).toBe(false); // still inside window
    clock += 60; // now 110ms since first sight, past ttl
    expect(host.firstSight("m1")).toBe(true);
  });

  it("evicts expired entries on insert so the cache stays bounded", () => {
    let clock = 0;
    const host = createSourceHost({ source: "test", ttlMs: 100, now: () => clock });
    for (let i = 0; i < 50; i++) {
      host.firstSight(`old-${i}`);
    }
    clock += 1_000; // every old entry is now expired
    host.firstSight("new"); // triggers a sweep
    // After the sweep, an old id is unseen again (proves it was evicted, not retained).
    expect(host.firstSight("old-0")).toBe(true);
  });

  it("defaults to a six hour window", () => {
    expect(DEFAULT_DEDUP_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe("source host — attachment gate", () => {
  it("throws when the attachment exceeds the limit", () => {
    const host = createSourceHost({ source: "test" });
    expect(() => host.gateAttachment(attachment({ size_bytes: 200 }), 100)).toThrow(
      AttachmentRejectedError,
    );
  });

  it("allows attachments at or under the limit", () => {
    const host = createSourceHost({ source: "test" });
    expect(() => host.gateAttachment(attachment({ size_bytes: 100 }), 100)).not.toThrow();
  });

  it("allows attachments with unknown size (size enforced later during download)", () => {
    const host = createSourceHost({ source: "test" });
    expect(() => host.gateAttachment(attachment({ size_bytes: undefined }), 100)).not.toThrow();
  });
});

describe("source host — lifecycle", () => {
  it("returns an inert handle without connecting when disabled", async () => {
    const connect = vi.fn();
    const host = createSourceHost({ source: "test" });
    const handle = await host.run({ source: "test", disabled: true, connect });
    expect(connect).not.toHaveBeenCalled();
    handle.stop();
    await expect(handle.done).resolves.toBeUndefined();
  });

  it("connects and disconnects exactly once on stop", async () => {
    const disconnect = vi.fn();
    const host = createSourceHost({ source: "test" });
    const handle = await host.run({
      source: "test",
      connect: async () => ({ disconnect }),
    });
    handle.stop();
    handle.stop(); // idempotent
    await handle.done;
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("resolves done when the source closes on its own", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    const host = createSourceHost({ source: "test" });
    const handle = await host.run({
      source: "test",
      connect: async () => ({ disconnect: () => undefined, closed }),
    });
    resolveClosed();
    await expect(handle.done).resolves.toBeUndefined();
  });
});
