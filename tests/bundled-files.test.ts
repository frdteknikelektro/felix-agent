import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyTextFileIfAbsent } from "../src/core/bundled-files.js";

describe("copyTextFileIfAbsent", () => {
  it("copies the bundled file on first boot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bundled-file-"));
    try {
      const source = path.join(dir, "src", "PERSONALITY.md");
      const destination = path.join(dir, "workspace", "PERSONALITY.md");
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, "# Personality\n\nWarm and concise.\n", "utf-8");

      await expect(copyTextFileIfAbsent(source, destination)).resolves.toBe("written");
      await expect(readFile(destination, "utf-8")).resolves.toBe("# Personality\n\nWarm and concise.\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves an existing user customization", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bundled-file-"));
    try {
      const source = path.join(dir, "PERSONALITY.md");
      const destination = path.join(dir, "workspace", "PERSONALITY.md");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(source, "default\n", "utf-8");
      await writeFile(destination, "custom\n", "utf-8");

      await expect(copyTextFileIfAbsent(source, destination)).resolves.toBe("skipped");
      await expect(readFile(destination, "utf-8")).resolves.toBe("custom\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
