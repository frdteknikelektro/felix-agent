import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContactEditorError,
  createContactFromEditor,
  grantPermissions,
  listContacts,
  loadContact,
  loadContactForEditor,
  saveContact,
  updateContactFromEditor,
} from "../src/slices/contacts/index.js";
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

describe("Contact editor", () => {
  it("creates a contact from editor input and normalizes permissions", async () => {
    const cfg = await makeCfg();

    const created = await createContactFromEditor(cfg, "mattermost", "user-7", {
      display: "Jala",
      username: "jala",
      allowed_permissions: "deploy:shell.run\n deploy:shell.run \nreports:usage.read",
      notes: "trusted operator",
    });

    expect(created).toEqual({
      source: "mattermost",
      user_id: "user-7",
      display: "Jala",
      username: "jala",
      allowed_permissions: ["deploy:shell.run", "reports:usage.read"],
      notes: "trusted operator",
    });
    await expect(loadContactForEditor(cfg, "mattermost", "user-7")).resolves.toMatchObject({
      allowed_permissions: ["deploy:shell.run", "reports:usage.read"],
    });
  });

  it("updates an existing contact while preserving fields outside the editor input", async () => {
    const cfg = await makeCfg();
    await saveContact(cfg, {
      source: "mattermost",
      user_id: "user-7",
      display: "Old Name",
      username: "old",
      alias: "Bob",
      allowed_permissions: ["deploy:shell.run"],
      notes: "old notes",
    });

    const updated = await updateContactFromEditor(cfg, "mattermost", "user-7", {
      display: "New Name",
      username: "new",
      allowed_permissions: ["reports:usage.read", "reports:usage.read", ""],
      notes: "new notes",
    });

    expect(updated).toEqual({
      source: "mattermost",
      user_id: "user-7",
      display: "New Name",
      username: "new",
      alias: "Bob",
      allowed_permissions: ["reports:usage.read"],
      notes: "new notes",
    });
  });

  it("returns null for missing editor loads and typed errors for invalid writes", async () => {
    const cfg = await makeCfg();

    await expect(loadContactForEditor(cfg, "mattermost", "user-7")).resolves.toBeNull();
    await expect(updateContactFromEditor(cfg, "mattermost", "user-7", {})).rejects.toMatchObject({
      code: "contact_missing",
    } satisfies Partial<ContactEditorError>);

    await createContactFromEditor(cfg, "mattermost", "user-7", {});
    await expect(createContactFromEditor(cfg, "mattermost", "user-7", {})).rejects.toMatchObject({
      code: "contact_exists",
    } satisfies Partial<ContactEditorError>);
  });

  it("lists existing contacts sorted by source and user id", async () => {
    const cfg = await makeCfg();
    await createContactFromEditor(cfg, "slack", "u2", { display: "Two" });
    await createContactFromEditor(cfg, "mattermost", "u1", { display: "One" });

    expect((await listContacts(cfg)).map((c) => `${c.source}:${c.user_id}`)).toEqual([
      "mattermost:u1",
      "slack:u2",
    ]);
  });
});
