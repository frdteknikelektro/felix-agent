import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGoogleWorkspaceOperation } from "../skills/google-workspace/scripts/run-workflow.mjs";

const helper = path.resolve("skills/google-workspace/scripts/import-credentials.mjs");

describe("Google Workspace credential import", () => {
  it("checks permission before auth, schema discovery, and execution", async () => {
    const calls: string[] = [];
    const result = await runGoogleWorkspaceOperation({
      checkPermission: async () => { calls.push("permission"); return true; },
      checkAuth: async () => { calls.push("auth"); },
      discoverSchema: async () => { calls.push("schema"); return { ok: true }; },
      execute: async (schema: unknown) => { calls.push("execute"); return schema; },
      needsSchema: true,
    });
    expect(calls).toEqual(["permission", "auth", "schema", "execute"]);
    expect(result).toEqual({ ok: true });
  });

  it("does not probe auth or schema when permission is denied", async () => {
    const calls: string[] = [];
    await expect(runGoogleWorkspaceOperation({
      checkPermission: async () => { calls.push("permission"); return false; },
      checkAuth: async () => { calls.push("auth"); },
      discoverSchema: async () => { calls.push("schema"); return {}; },
      execute: async () => { calls.push("execute"); },
      needsSchema: true,
    })).rejects.toThrow("google_workspace_permission_required");
    expect(calls).toEqual(["permission"]);
  });

  it("imports an ephemeral credential template and removes it after success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "felix-gog-test-"));
    const bin = path.join(root, "gog");
    const marker = path.join(root, "marker");
    await writeFile(bin, `#!/bin/sh\nprintf '%s' "$4" > "$MARKER"\nexit 0\n`);
    await chmod(bin, 0o755);

    try {
      execFileSync(process.execPath, [helper], {
        env: {
          ...process.env,
          GOG_BIN: bin,
          MARKER: marker,
          GOOGLE_CLIENT_ID: "client-id",
          GOOGLE_CLIENT_SECRET: "client-secret",
        },
        stdio: "ignore",
      });
      const templatePath = await readFile(marker, "utf8");
      expect(templatePath).toContain("/felix-google-");
      await expect(readFile(templatePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the temporary template when gog fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "felix-gog-test-failure-"));
    const bin = path.join(root, "gog");
    const marker = path.join(root, "marker");
    await writeFile(bin, `#!/bin/sh\nprintf '%s' "$4" > "$MARKER"\nexit 7\n`);
    await chmod(bin, 0o755);

    try {
      expect(() => execFileSync(process.execPath, [helper], {
        env: {
          ...process.env,
          GOG_BIN: bin,
          MARKER: marker,
          GOOGLE_CLIENT_ID: "client-id",
          GOOGLE_CLIENT_SECRET: "client-secret",
        },
        stdio: "ignore",
      })).toThrow();
      const templatePath = await readFile(marker, "utf8");
      await expect(readFile(templatePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the GOG_HOME file keyring state through restart and restore", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "felix-gog-state-"));
    const restored = await mkdtemp(path.join(os.tmpdir(), "felix-gog-restore-"));
    const gogHome = path.join(workspace, ".config", "gogcli");
    const keyring = path.join(gogHome, "keyring.json");
    try {
      await mkdir(gogHome, { recursive: true });
      await writeFile(keyring, '{"account":"owner@example.com"}\n', { mode: 0o600 });
      expect(await readFile(keyring, "utf8")).toContain("owner@example.com");

      await cp(workspace, restored, { recursive: true });
      expect(await readFile(path.join(restored, ".config", "gogcli", "keyring.json"), "utf8"))
        .toContain("owner@example.com");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(restored, { recursive: true, force: true });
    }
  });

});
