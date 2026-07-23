import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspacePaths,
  ensureWorkspace,
  projectNamespaceDir,
  projectProviderDir,
  projectRepoDir,
  sourceContactsDir,
  sourceRawDir,
  sourceSessionsDir,
  sourceThreadKeyIndexDir,
} from "../src/workspace.js";

describe("workspace paths", () => {
  it("groups paths by intake, sessions, catalog, runtime, and index zones", () => {
    const paths = buildWorkspacePaths("/workspace");

    expect(paths.intake).toBe(path.join("/workspace", "intake"));
    expect(paths.sessions).toBe(path.join("/workspace", "sessions"));
    expect(paths.approvals).toBe(path.join("/workspace", "approvals"));
    expect(paths.audit).toBe(path.join("/workspace", "audit.jsonl"));
    expect(paths.botMessageIndex).toBe(path.join("/workspace", "index", "bot-messages"));
    expect(paths.skills).toBe(path.join("/workspace", ".agents", "skills"));
    expect(paths.contacts).toBe(path.join("/workspace", "catalog", "contacts"));
    expect(paths.bin).toBe(path.join("/workspace", "runtime", "bin"));
    expect(paths.tools).toBe(path.join("/workspace", "runtime", "tools"));
    expect(paths.python).toBe(path.join("/workspace", "runtime", "python"));
    expect(paths.threadKeyIndex).toBe(path.join("/workspace", "index", "thread-key"));
    expect(paths.projects).toBe(path.join("/workspace", "projects"));
  });

  it("uses source-scoped directories for extensible source data", () => {
    const paths = buildWorkspacePaths("/workspace");

    expect(sourceRawDir(paths, "slack")).toBe(path.join("/workspace", "intake", "slack", "raw"));
    expect(sourceSessionsDir(paths, "telegram")).toBe(path.join("/workspace", "sessions", "telegram"));
    expect(sourceContactsDir(paths, "mattermost")).toBe(path.join("/workspace", "catalog", "contacts", "mattermost"));
    expect(sourceThreadKeyIndexDir(paths, "mattermost")).toBe(path.join("/workspace", "index", "thread-key", "mattermost"));
  });

  it("groups target repositories by provider, namespace, and repo name", () => {
    const paths = buildWorkspacePaths("/workspace");

    expect(projectProviderDir(paths, "github")).toBe(path.join("/workspace", "projects", "github"));
    expect(projectNamespaceDir(paths, "gitlab", "acme")).toBe(path.join("/workspace", "projects", "gitlab", "acme"));
    expect(projectRepoDir(paths, "github", "acme", "payments")).toBe(path.join("/workspace", "projects", "github", "acme", "payments"));
  });

  it("initializes Memory lazily while preserving inactive Legacy memory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-memory-workspace-"));
    const paths = buildWorkspacePaths(root);
    const legacyFile = path.join(root, "memory", "wiki", "index.md");
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(legacyFile, "legacy bytes stay unchanged\n");

    try {
      await ensureWorkspace(paths);

      expect(await fs.readFile(paths.memoryFile, "utf8")).toBe("# Memory\n");
      expect((await fs.stat(paths.memoryDailyDir)).isDirectory()).toBe(true);
      expect((await fs.stat(paths.memoryWeeklyDir)).isDirectory()).toBe(true);
      expect((await fs.stat(paths.memoryMonthlyDir)).isDirectory()).toBe(true);
      expect(await fs.readFile(legacyFile, "utf8")).toBe("legacy bytes stay unchanged\n");

      await fs.writeFile(paths.memoryFile, "# Memory\n\n- Owner customization\n");
      await ensureWorkspace(paths);
      expect(await fs.readFile(paths.memoryFile, "utf8")).toContain("Owner customization");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
