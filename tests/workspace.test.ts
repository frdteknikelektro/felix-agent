import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspacePaths,
  ensureWorkspace,
  fileCollectionDir,
  localProjectDir,
  projectNamespaceDir,
  projectProviderDir,
  projectRepoDir,
  resolveWorkspaceTarget,
  sourceContactsDir,
  sourceRawDir,
  sourceSessionsDir,
  sourceThreadKeyIndexDir,
  workspaceSlug,
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
    expect(paths.localProjects).toBe(path.join("/workspace", "projects", "local"));
    expect(paths.fileCollections).toBe(path.join("/workspace", "files"));
  });

  it("provisions persistent local-project and file-collection roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-paths-"));
    const paths = buildWorkspacePaths(path.join(root, "workspace"));

    try {
      await ensureWorkspace(paths);

      expect((await fs.stat(paths.localProjects)).isDirectory()).toBe(true);
      expect((await fs.stat(paths.fileCollections)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

  it("derives readable canonical paths from human names", () => {
    const paths = buildWorkspacePaths("/workspace");

    expect(workspaceSlug("Jala Cost Report")).toBe("jala-cost-report");
    expect(workspaceSlug("  Café 2026  ")).toBe("café-2026");
    expect(localProjectDir(paths, "My App")).toBe(path.join("/workspace", "projects", "local", "my-app"));
    expect(fileCollectionDir(paths, "Quarterly Invoices")).toBe(path.join("/workspace", "files", "quarterly-invoices"));
    expect(() => workspaceSlug("..")).toThrow(/usable/i);
    expect(() => workspaceSlug("///")).toThrow(/separator/i);
    expect(() => workspaceSlug("team/app")).toThrow(/separator/i);
    expect(() => workspaceSlug("report\u0000draft")).toThrow(/control/i);
  });

  it("resolves complete canonical target shapes from typed categories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-targets-"));
    const paths = buildWorkspacePaths(path.join(root, "workspace"));
    const threadDir = path.join(paths.sessions, "mattermost", "session-1");
    await ensureWorkspace(paths);
    await fs.mkdir(path.join(threadDir, "work"), { recursive: true });
    await fs.mkdir(path.join(threadDir, "attachments"), { recursive: true });

    try {
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "file_collection",
          collection: "Invoices",
          relative: "Draft Folder/Final!.PDF",
        }),
      ).resolves.toBe(path.join(paths.fileCollections, "invoices", "draft-folder", "final.pdf"));
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "file_collection",
          collection: "Invoices",
          relative: "2026/january.pdf",
        }),
      ).resolves.toBe(path.join(paths.fileCollections, "invoices", "2026", "january.pdf"));
      await expect(
        resolveWorkspaceTarget(paths, { kind: "local_project", project: "My App" }),
      ).resolves.toBe(path.join(paths.localProjects, "my-app"));
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "hosted_project",
          provider: "github",
          namespace: ["Acme"],
          repo: "Payments",
          relative: "src/index.ts",
        }),
      ).resolves.toBe(path.join(paths.projects, "github", "acme", "payments", "src", "index.ts"));
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "session_work",
          threadDir,
          workName: "PDF Conversion",
          relative: "input.txt",
        }),
      ).resolves.toBe(path.join(threadDir, "work", "pdf-conversion", "input.txt"));
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "session_attachment",
          threadDir,
          filename: "report.pdf",
        }),
      ).resolves.toBe(path.join(threadDir, "attachments", "report.pdf"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed targets plus cross-category and dangling symlink escapes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-containment-"));
    const workspace = path.join(root, "workspace");
    const paths = buildWorkspacePaths(workspace);
    await ensureWorkspace(paths);
    const hosted = path.join(paths.projects, "github", "acme", "app");
    const collection = path.join(paths.fileCollections, "invoices");
    await fs.mkdir(hosted, { recursive: true });
    await fs.mkdir(collection, { recursive: true });
    await fs.mkdir(path.join(paths.sessions, "mattermost"));
    await fs.symlink(hosted, path.join(collection, "code"));
    await fs.symlink(path.join(root, "missing-outside"), path.join(collection, "dangling"));

    try {
      await expect(
        resolveWorkspaceTarget(paths, { kind: "file_collection", collection: "Invoices", relative: "code/secret.txt" }),
      ).rejects.toThrow(/outside.*file collection/i);
      await expect(
        resolveWorkspaceTarget(paths, { kind: "file_collection", collection: "Invoices", relative: "dangling/secret.txt" }),
      ).rejects.toThrow(/symbolic link/i);
      await expect(
        resolveWorkspaceTarget(paths, { kind: "file_collection", collection: "Invoices", relative: "../other" }),
      ).rejects.toThrow(/relative path/i);
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "session_work",
          threadDir: path.join(root, "outside-session"),
          workName: "Attempt",
        }),
      ).rejects.toThrow(/session/i);
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "session_work",
          threadDir: path.join(paths.sessions, "mattermost"),
          workName: "Attempt",
        }),
      ).rejects.toThrow(/source.*session id/i);
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "hosted_project",
          provider: "github",
          namespace: [],
          repo: "app",
        }),
      ).rejects.toThrow(/namespace/i);
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "hosted_project",
          provider: "bitbucket" as "github",
          namespace: ["acme"],
          repo: "app",
        }),
      ).rejects.toThrow(/provider/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a canonical category root redirected into another category", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-root-link-"));
    const paths = buildWorkspacePaths(path.join(root, "workspace"));
    await ensureWorkspace(paths);
    await fs.rmdir(paths.fileCollections);
    await fs.symlink(paths.localProjects, paths.fileCollections);

    try {
      await expect(
        resolveWorkspaceTarget(paths, { kind: "file_collection", collection: "Invoices" }),
      ).rejects.toThrow(/canonical.*file collection/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects existing hard-linked files as mutation targets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "felix-workspace-hard-link-"));
    const paths = buildWorkspacePaths(path.join(root, "workspace"));
    await ensureWorkspace(paths);
    const outside = path.join(root, "outside.txt");
    const insideDir = path.join(paths.fileCollections, "documents");
    const inside = path.join(insideDir, "shared.txt");
    const alias = path.join(insideDir, "alias.txt");
    await fs.writeFile(outside, "shared");
    await fs.mkdir(insideDir);
    await fs.link(outside, inside);
    await fs.symlink(inside, alias);

    try {
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "file_collection",
          collection: "Documents",
          relative: "shared.txt",
        }),
      ).rejects.toThrow(/hard link/i);
      await expect(
        resolveWorkspaceTarget(paths, {
          kind: "file_collection",
          collection: "Documents",
          relative: "alias.txt",
        }),
      ).rejects.toThrow(/hard link/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
