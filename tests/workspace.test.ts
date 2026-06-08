import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspacePaths,
  projectNamespaceDir,
  projectProviderDir,
  projectRepoDir,
  sourceContactsDir,
  sourceRawDir,
  sourceSessionsDir,
  sourceThreadKeyIndexDir,
} from "../src/workspace.js";

describe("workspace paths", () => {
  it("groups paths by intake, records, catalog, runtime, and index zones", () => {
    const paths = buildWorkspacePaths("/workspace");

    expect(paths.intake).toBe(path.join("/workspace", "intake"));
    expect(paths.sessions).toBe(path.join("/workspace", "records", "sessions"));
    expect(paths.approvals).toBe(path.join("/workspace", "records", "approvals"));
    expect(paths.audit).toBe(path.join("/workspace", "records", "audit.jsonl"));
    expect(paths.skills).toBe(path.join("/workspace", "catalog", "skills"));
    expect(paths.contacts).toBe(path.join("/workspace", "catalog", "contacts"));
    expect(paths.bin).toBe(path.join("/workspace", "runtime", "bin"));
    expect(paths.tools).toBe(path.join("/workspace", "runtime", "tools"));
    expect(paths.python).toBe(path.join("/workspace", "runtime", "python"));
    expect(paths.health).toBe(path.join("/workspace", "runtime", "health"));
    expect(paths.threadKeyIndex).toBe(path.join("/workspace", "index", "thread-key"));
    expect(paths.projects).toBe(path.join("/workspace", "projects"));
  });

  it("uses source-scoped directories for extensible source data", () => {
    const paths = buildWorkspacePaths("/workspace");

    expect(sourceRawDir(paths, "slack")).toBe(path.join("/workspace", "intake", "slack", "raw"));
    expect(sourceSessionsDir(paths, "telegram")).toBe(path.join("/workspace", "records", "sessions", "telegram"));
    expect(sourceContactsDir(paths, "mattermost")).toBe(path.join("/workspace", "catalog", "contacts", "mattermost"));
    expect(sourceThreadKeyIndexDir(paths, "mattermost")).toBe(path.join("/workspace", "index", "thread-key", "mattermost"));
  });

  it("groups target repositories by provider, namespace, and repo name", () => {
    const paths = buildWorkspacePaths("/workspace");

    expect(projectProviderDir(paths, "github")).toBe(path.join("/workspace", "projects", "github"));
    expect(projectNamespaceDir(paths, "gitlab", "acme")).toBe(path.join("/workspace", "projects", "gitlab", "acme"));
    expect(projectRepoDir(paths, "github", "acme", "payments")).toBe(path.join("/workspace", "projects", "github", "acme", "payments"));
  });
});
