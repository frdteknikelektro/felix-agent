import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryMemory } from "../../src/slices/memory/query.js";
import type { AppConfig } from "../../src/config.js";
import { buildWorkspacePaths } from "../../src/workspace.js";

const tmp = path.join(process.cwd(), "tests", ".tmp", "memory-query");

function makeConfig(dir: string): AppConfig {
  return {
    WORKSPACE_DIR: dir,
    paths: buildWorkspacePaths(dir),
  } as unknown as AppConfig;
}

describe("memory query", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, "memory", "wiki", "entities"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "memory", "wiki", "concepts"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "memory", "wiki", "sessions", "mattermost"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when index.md does not exist", async () => {
    const cfg = makeConfig(tmp);
    const result = queryMemory(cfg, "deployment region");
    expect(result).toBeNull();
  });

  it("returns null when index has no matching entries", async () => {
    const cfg = makeConfig(tmp);
    const wikiDir = path.join(tmp, "memory", "wiki");
    fs.writeFileSync(
      path.join(wikiDir, "index.md"),
      [
        "# Wiki Index",
        "",
        "## Entities",
        "- [entity] [[entities/alice]] — DevOps lead, prefers us-west-2",
        "",
        "## Concepts",
        "- [concept] [[concepts/multi-tenant-rls]] — Row-level security for databases",
      ].join("\n"),
      "utf8",
    );

    const result = queryMemory(cfg, "what about the python linter?");
    expect(result).toBeNull();
  });

  it("returns matching pages when keywords overlap", async () => {
    const cfg = makeConfig(tmp);
    const wikiDir = path.join(tmp, "memory", "wiki");

    fs.writeFileSync(
      path.join(wikiDir, "index.md"),
      [
        "# Wiki Index",
        "",
        "## Entities",
        "- [entity] [[entities/alice]] — DevOps lead, manages deployment pipelines",
        "",
        "## Concepts",
        "- [concept] [[concepts/deployment-regions]] — Always deploy to us-west-2",
        "",
        "## Sessions",
        "- [session] [[sessions/mattermost/2026-06-19_auth]] — Auth migration discussion",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      path.join(wikiDir, "entities", "alice.md"),
      [
        "---",
        'title: "Alice"',
        "type: entity",
        "tags: [person, devops]",
        'updated_at: "2026-06-19T14:00:00Z"',
        "sources: [mattermost:c:m]",
        "---",
        "",
        "# Alice",
        "",
        "DevOps lead. Always deploys to us-west-2.",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      path.join(wikiDir, "concepts", "deployment-regions.md"),
      [
        "---",
        'title: "Deployment Regions"',
        "type: concept",
        "tags: [infrastructure, deployment]",
        'updated_at: "2026-06-19T14:00:00Z"',
        "sources: [mattermost:c:m]",
        "---",
        "",
        "# Deployment Regions",
        "",
        "All production deployments go to us-west-2. us-east-1 is not used.",
      ].join("\n"),
      "utf8",
    );

    const result = queryMemory(cfg, "where do we deploy production?");
    expect(result).not.toBeNull();
    expect(result).toContain("Alice");
    expect(result).toContain("Deployment Regions");
    expect(result).not.toBeNull();
  });

  it("returns at most 3 pages", async () => {
    const cfg = makeConfig(tmp);
    const wikiDir = path.join(tmp, "memory", "wiki");

    const lines = ["# Wiki Index", ""];
    for (let i = 0; i < 10; i++) {
      lines.push(`## Section ${i}`);
      lines.push(`- [concept] [[concepts/deployment-${i}]] — Deployment topic ${i}`);
    }
    fs.writeFileSync(path.join(wikiDir, "index.md"), lines.join("\n"), "utf8");

    for (let i = 0; i < 10; i++) {
      fs.mkdirSync(path.join(wikiDir, "concepts"), { recursive: true });
      fs.writeFileSync(
        path.join(wikiDir, "concepts", `deployment-${i}.md`),
        [
          "---",
          `title: "Deployment ${i}"`,
          "type: concept",
          "tags: [deployment]",
          'updated_at: "2026-06-19T14:00:00Z"',
          "sources: []",
          "---",
          "",
          `Content for deployment ${i}.`,
        ].join("\n"),
        "utf8",
      );
    }

    const result = queryMemory(cfg, "deployment");
    expect(result).not.toBeNull();
    const sections = result!.split("\n### ").filter(Boolean);
    expect(sections.length).toBeLessThanOrEqual(3);
  });

  it("returns null when no pages exist for matching index entries", async () => {
    const cfg = makeConfig(tmp);
    const wikiDir = path.join(tmp, "memory", "wiki");

    fs.writeFileSync(
      path.join(wikiDir, "index.md"),
      "- [entity] [[entities/ghost]] — This page does not exist on disk\n",
      "utf8",
    );

    const result = queryMemory(cfg, "ghost");
    expect(result).toBeNull();
  });
});
