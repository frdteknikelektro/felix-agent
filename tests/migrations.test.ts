import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateWorkspaceLayout } from "../src/migrations.js";
import { makeTestConfig } from "./helpers/workspace.js";
import type { AppConfig } from "../src/config.js";

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

describe("workspace layout migration", () => {
  let cfg: AppConfig;
  let root: string;
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    cfg = await makeTestConfig("felix-migrate-");
    root = cfg.paths.root;
    // Point HOME at a clean dir so the wacli relocation is observable and
    // never touches the developer's real ~/.local/state/wacli.
    originalHome = process.env.HOME;
    home = path.join(root, "fake-home");
    await fs.mkdir(home, { recursive: true });
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  async function seedLegacyWorkspace(): Promise<void> {
    const recordsSessions = path.join(root, "records", "sessions", "mattermost", "2026_thread");
    await fs.mkdir(path.join(recordsSessions, "events"), { recursive: true });
    const eventOld = path.join(recordsSessions, "events", "evt.md");
    const permOld = path.join(recordsSessions, "events", "perm.md");
    await fs.writeFile(eventOld, "event", "utf8");
    await fs.writeFile(permOld, "perm", "utf8");
    await fs.writeFile(
      path.join(recordsSessions, "session.json"),
      JSON.stringify({
        busy: false,
        queue: [{ received_at: "t", event_file: eventOld, source_event_id: "e1" }],
        pending_permission: { request_id: "r1", requester_event_file: permOld },
      }),
      "utf8",
    );

    const recordsApprovals = path.join(root, "records", "approvals", "mattermost_chan_root");
    await fs.mkdir(recordsApprovals, { recursive: true });
    await fs.writeFile(
      path.join(recordsApprovals, "r1.json"),
      JSON.stringify({ id: "r1", requestPath: permOld, decisionPath: eventOld }),
      "utf8",
    );

    await fs.writeFile(path.join(root, "records", "audit.jsonl"), '{"id":"a1"}\n', "utf8");
    const botDir = path.join(root, "records", "bot_messages", "whatsapp");
    await fs.mkdir(botDir, { recursive: true });
    await fs.writeFile(path.join(botDir, "m1.json"), '{"msgId":"m1"}', "utf8");

    const wacli = path.join(root, "runtime", "wacli");
    await fs.mkdir(wacli, { recursive: true });
    await fs.writeFile(path.join(wacli, "session.db"), "sqlite", "utf8");
  }

  it("moves records children up, removes records/, and relocates wacli", async () => {
    await seedLegacyWorkspace();
    await migrateWorkspaceLayout(cfg);

    expect(await exists(path.join(root, "records"))).toBe(false);
    expect(await exists(path.join(root, "sessions", "mattermost", "2026_thread", "session.json"))).toBe(true);
    expect(await exists(path.join(root, "approvals", "mattermost_chan_root", "r1.json"))).toBe(true);
    expect(await exists(path.join(root, "audit.jsonl"))).toBe(true);
    expect(await exists(path.join(root, "index", "bot-messages", "whatsapp", "m1.json"))).toBe(true);
    expect(await exists(path.join(home, ".local", "state", "wacli", "session.db"))).toBe(true);
  });

  it("rewrites stored absolute paths to the new sessions location", async () => {
    await seedLegacyWorkspace();
    await migrateWorkspaceLayout(cfg);

    const session = await readJson(path.join(root, "sessions", "mattermost", "2026_thread", "session.json"));
    const expectedEvent = path.join(cfg.paths.sessions, "mattermost", "2026_thread", "events", "evt.md");
    const expectedPerm = path.join(cfg.paths.sessions, "mattermost", "2026_thread", "events", "perm.md");
    expect(session.queue[0].event_file).toBe(expectedEvent);
    expect(session.queue[0].event_file).not.toContain("records");
    expect(session.pending_permission.requester_event_file).toBe(expectedPerm);

    const approval = await readJson(path.join(root, "approvals", "mattermost_chan_root", "r1.json"));
    expect(approval.requestPath).toBe(expectedPerm);
    expect(approval.decisionPath).toBe(expectedEvent);
    expect(approval.requestPath).not.toContain("records");
  });

  it("is idempotent: a second run is a clean no-op", async () => {
    await seedLegacyWorkspace();
    await migrateWorkspaceLayout(cfg);
    const before = await readJson(path.join(root, "sessions", "mattermost", "2026_thread", "session.json"));

    await expect(migrateWorkspaceLayout(cfg)).resolves.toBeUndefined();

    expect(await exists(path.join(root, "sessions", "sessions"))).toBe(false);
    const after = await readJson(path.join(root, "sessions", "mattermost", "2026_thread", "session.json"));
    expect(after).toEqual(before);
  });

  it("no-ops on a fresh workspace with no records/", async () => {
    await expect(migrateWorkspaceLayout(cfg)).resolves.toBeUndefined();
    expect(await exists(path.join(root, "records"))).toBe(false);
    expect(await exists(path.join(root, "sessions"))).toBe(false);
  });
});
