import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { grantPermissions, loadContact, saveContact } from "../src/slices/contacts/index.js";
import type { AppConfig } from "../src/config.js";
import type { SourceSender } from "../src/types.js";
import { buildWorkspacePaths } from "../src/workspace.js";

async function makeCfg(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-contacts-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  return {
    WORKSPACE_DIR: workspace,
    paths: buildWorkspacePaths(workspace),
  } as never;
}

const requester: SourceSender = { source: "mattermost", id: "user-7", display: "Jala" };

describe("grantPermissions", () => {
  it("creates a contact with the granted permissions", async () => {
    const cfg = await makeCfg();
    const next = await grantPermissions(cfg, requester, ["test-skill:net:fetch"]);

    expect(next.allowed_permissions).toEqual(["test-skill:net:fetch"]);
    expect(next.display).toBe("Jala");
    // persisted, not just returned
    const stored = await loadContact(cfg, "mattermost", "user-7");
    expect(stored.allowed_permissions).toEqual(["test-skill:net:fetch"]);
  });

  it("accumulates additively and de-duplicates against existing grants", async () => {
    const cfg = await makeCfg();
    await saveContact(cfg, {
      source: "mattermost",
      user_id: "user-7",
      allowed_permissions: ["test-skill:net:fetch"],
    });

    const next = await grantPermissions(cfg, requester, ["test-skill:net:fetch", "test-skill:fs:write"]);

    expect(next.allowed_permissions).toEqual(["test-skill:net:fetch", "test-skill:fs:write"]);
  });

  it("preserves an existing display when the requester carries none", async () => {
    const cfg = await makeCfg();
    await saveContact(cfg, {
      source: "mattermost",
      user_id: "user-7",
      display: "Existing Name",
      allowed_permissions: [],
    });

    const next = await grantPermissions(cfg, { source: "mattermost", id: "user-7" }, []);
    expect(next.display).toBe("Existing Name");
  });
});
