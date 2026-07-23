import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspacePathCommand,
} from "../src/cli/workspace-path.js";
import { installWorkspacePathCommand } from "../src/workspace-command.js";
import { buildWorkspacePaths, ensureWorkspace } from "../src/workspace.js";

describe("felix-workspace-path", () => {
  it("resolves a complete category target from command arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-command-"));
    const workspace = path.join(root, "workspace");
    await ensureWorkspace(buildWorkspacePaths(workspace));

    try {
      await expect(
        resolveWorkspacePathCommand(["file-collection", "Quarterly Invoices", "2026/q1.pdf"], workspace),
      ).resolves.toBe(path.join(workspace, "files", "quarterly-invoices", "2026", "q1.pdf"));
      await expect(
        resolveWorkspacePathCommand(["hosted-project", "github", "Acme/Payments", "API", "src/index.ts"], workspace),
      ).resolves.toBe(path.join(workspace, "projects", "github", "acme", "payments", "api", "src", "index.ts"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete command arguments instead of accepting broad roots", async () => {
    await expect(resolveWorkspacePathCommand(["file-collection"], "/workspace")).rejects.toThrow(/usage/i);
    await expect(resolveWorkspacePathCommand(["hosted-project", "github", "acme"], "/workspace")).rejects.toThrow(
      /usage/i,
    );
  });

  it("binds Session targets to the active thread", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-thread-command-"));
    const workspace = path.join(root, "workspace");
    const paths = buildWorkspacePaths(workspace);
    const currentThread = path.join(paths.sessions, "mattermost", "session-1");
    const otherThread = path.join(paths.sessions, "mattermost", "session-2");
    await ensureWorkspace(paths);
    await fs.mkdir(path.join(currentThread, "attachments"), { recursive: true });
    await fs.mkdir(path.join(otherThread, "attachments"), { recursive: true });

    try {
      await expect(
        resolveWorkspacePathCommand(
          ["session-attachment", currentThread, "Result File.PDF"],
          workspace,
          currentThread,
        ),
      ).resolves.toBe(path.join(currentThread, "attachments", "result-file.pdf"));
      await expect(
        resolveWorkspacePathCommand(
          ["session-attachment", otherThread, "result.pdf"],
          workspace,
          currentThread,
        ),
      ).rejects.toThrow(/active thread/i);
      await expect(
        resolveWorkspacePathCommand(["session-attachment", currentThread, "result.pdf"], workspace),
      ).rejects.toThrow(/active thread/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("installs an executable command wrapper in the workspace runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-wrapper-"));
    const paths = buildWorkspacePaths(path.join(root, "workspace"));
    await ensureWorkspace(paths);

    try {
      const wrapper = await installWorkspacePathCommand(paths, "/app/dist/cli/workspace-path.js", "/usr/bin/node");
      const stat = await fs.stat(wrapper);
      const content = await fs.readFile(wrapper, "utf8");

      expect(wrapper).toBe(path.join(paths.bin, "felix-workspace-path"));
      expect(stat.mode & 0o111).not.toBe(0);
      expect(content).toContain("/usr/bin/node");
      expect(content).toContain("/app/dist/cli/workspace-path.js");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
