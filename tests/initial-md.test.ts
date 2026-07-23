import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildInitialMd } from "../src/core/initial-md.js";
import { buildWorkspacePaths } from "../src/workspace.js";
import type { AppConfig } from "../src/config.js";

function makeCfg(threadDir: string): AppConfig {
  return {
    WORKSPACE_DIR: "/workspace",
    HARNESS: "codex",
    OWNER_TZ: "Asia/Jakarta",
    paths: buildWorkspacePaths("/workspace"),
  } as never;
}

describe("buildInitialMd", () => {
  it("writes INITIAL.md with session context", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "initial-md-"));
    try {
      const cfg = makeCfg(tmpDir);
      const result = await buildInitialMd({
        cfg,
        sessionId: "sess-123",
        harnessType: "codex",
        threadDir: tmpDir,
        behaviorInstructions: [],
      });

      expect(result).toBe(path.join(tmpDir, "INITIAL.md"));
      const content = await readFile(result, "utf-8");
      expect(content).toContain("Session ID");
      expect(content).toContain("sess-123");
      expect(content).toContain("Harness");
      expect(content).toContain("codex");
      expect(content).toContain("Owner timezone");
      expect(content).toContain("Asia/Jakarta");
      expect(content).toContain("Do not rewrite it");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes behavior instructions when provided", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "initial-md-"));
    try {
      const cfg = makeCfg(tmpDir);
      await buildInitialMd({
        cfg,
        sessionId: "sess-456",
        harnessType: "opencode",
        threadDir: tmpDir,
        behaviorInstructions: [
          "Use FELIX_REPLY for all output.",
          "For threads, only answer when mentioned.",
        ],
      });

      const content = await readFile(path.join(tmpDir, "INITIAL.md"), "utf-8");
      expect(content).toContain("Platform Instructions");
      expect(content).toContain("Use FELIX_REPLY for all output.");
      expect(content).toContain("For threads, only answer when mentioned.");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not inject owner identity or permission state", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "initial-md-"));
    try {
      await buildInitialMd({
        cfg: makeCfg(tmpDir),
        sessionId: "sess-no-owner",
        harnessType: "codex",
        threadDir: tmpDir,
        behaviorInstructions: [],
      });

      const content = await readFile(path.join(tmpDir, "INITIAL.md"), "utf-8");
      expect(content).not.toContain("## Owner");
      expect(content).not.toContain("owner_permission");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
