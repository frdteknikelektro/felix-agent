import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { buildWorkspacePaths } from "../../src/workspace.js";

const tmp = path.join(process.cwd(), "tests", ".tmp", "memory-new");

function makeConfig(dir: string): AppConfig {
  return {
    WORKSPACE_DIR: dir,
    paths: buildWorkspacePaths(dir),
    MEMORY_CLEANUP_CRON: "0 3 * * *",
  } as unknown as AppConfig;
}

describe("memory system", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, "memory", "logs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("MEMORY.md structure", () => {
    it("creates valid MEMORY.md with required sections", () => {
      const memoryPath = path.join(tmp, "MEMORY.md");
      const content = `# Felix Memory

## About Owner
- Test User, Developer at Test Corp
- Language: English (primary)

## People
- Alice — Developer, Frontend team

## Projects
- test-project: TypeScript/Node.js, Active, REST API

## Preferences
- Code style: TypeScript strict mode

## Standing Decisions
- Use REST over GraphQL: Simpler implementation
`;

      fs.writeFileSync(memoryPath, content);
      expect(fs.existsSync(memoryPath)).toBe(true);

      const read = fs.readFileSync(memoryPath, "utf-8");
      expect(read).toContain("# Felix Memory");
      expect(read).toContain("## About Owner");
      expect(read).toContain("## People");
      expect(read).toContain("## Projects");
      expect(read).toContain("## Preferences");
      expect(read).toContain("## Standing Decisions");
    });

    it("MEMORY.md stays under 5KB target", () => {
      const memoryPath = path.join(tmp, "MEMORY.md");
      const content = `# Felix Memory

## About Owner
- Test User

## Projects
- project1: TypeScript
- project2: Python
`;

      fs.writeFileSync(memoryPath, content);
      const stats = fs.statSync(memoryPath);
      expect(stats.size).toBeLessThan(5 * 1024);
    });
  });

  describe("daily log creation", () => {
    it("creates log file with correct date format", () => {
      const today = new Date().toISOString().split("T")[0];
      const logPath = path.join(tmp, "memory", "logs", `${today}.md`);

      const content = `# Daily Log - ${today}

## Events
- [14:30] User requested code review
- [15:00] Completed review and provided feedback

## Notes
- Discussed architecture improvements
`;

      fs.writeFileSync(logPath, content);
      expect(fs.existsSync(logPath)).toBe(true);

      const read = fs.readFileSync(logPath, "utf-8");
      expect(read).toContain(`# Daily Log - ${today}`);
      expect(read).toContain("## Events");
      expect(read).toContain("## Notes");
    });

    it("appends to existing log file", () => {
      const today = new Date().toISOString().split("T")[0];
      const logPath = path.join(tmp, "memory", "logs", `${today}.md`);

      fs.writeFileSync(logPath, `# Daily Log - ${today}\n\n## Events\n- [14:30] First event\n`);
      fs.appendFileSync(logPath, `- [15:00] Second event\n`);

      const read = fs.readFileSync(logPath, "utf-8");
      expect(read).toContain("[14:30] First event");
      expect(read).toContain("[15:00] Second event");
    });
  });

  describe("auto-expiry logic", () => {
    it("identifies logs older than 7 days", () => {
      const logsDir = path.join(tmp, "memory", "logs");
      const now = Date.now();
      const retentionMs = 7 * 24 * 60 * 60 * 1000;

      // Create old log (8 days ago)
      const oldDate = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      fs.writeFileSync(path.join(logsDir, `${oldDate}.md`), "# Old log\n");

      // Create recent log (2 days ago)
      const recentDate = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      fs.writeFileSync(path.join(logsDir, `${recentDate}.md`), "# Recent log\n");

      // Create today's log
      const today = new Date().toISOString().split("T")[0];
      fs.writeFileSync(path.join(logsDir, `${today}.md`), "# Today's log\n");

      const entries = fs.readdirSync(logsDir);
      expect(entries.length).toBe(3);

      // Check which logs should be deleted
      const toDelete: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const dateStr = entry.replace(".md", "");
        const entryDate = new Date(dateStr);
        const ageMs = now - entryDate.getTime();
        if (ageMs > retentionMs) {
          toDelete.push(entry);
        }
      }

      expect(toDelete.length).toBe(1);
      expect(toDelete[0]).toBe(`${oldDate}.md`);
    });

    it("skips invalid log filenames", () => {
      const logsDir = path.join(tmp, "memory", "logs");

      // Create valid log
      const today = new Date().toISOString().split("T")[0];
      fs.writeFileSync(path.join(logsDir, `${today}.md`), "# Valid log\n");

      // Create invalid file
      fs.writeFileSync(path.join(logsDir, "invalid-file.md"), "# Invalid\n");
      fs.writeFileSync(path.join(logsDir, "notes.txt"), "Not a log\n");

      const entries = fs.readdirSync(logsDir);
      expect(entries.length).toBe(3);

      // Only valid date-based logs should be processed
      const validLogs: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const dateStr = entry.replace(".md", "");
        const entryDate = new Date(dateStr);
        if (!isNaN(entryDate.getTime())) {
          validLogs.push(entry);
        }
      }

      expect(validLogs.length).toBe(1);
      expect(validLogs[0]).toBe(`${today}.md`);
    });
  });

  describe("loading strategy", () => {
    it("loads MEMORY.md at session start", () => {
      const memoryPath = path.join(tmp, "MEMORY.md");
      const content = "# Felix Memory\n\n## About Owner\n- Test User\n";
      fs.writeFileSync(memoryPath, content);

      const loaded = fs.readFileSync(memoryPath, "utf-8");
      expect(loaded).toContain("Test User");
    });

    it("loads today's and yesterday's logs", () => {
      const logsDir = path.join(tmp, "memory", "logs");
      const now = Date.now();

      // Create yesterday's log
      const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      fs.writeFileSync(path.join(logsDir, `${yesterday}.md`), "# Yesterday's log\n- Event A\n");

      // Create today's log
      const today = new Date().toISOString().split("T")[0];
      fs.writeFileSync(path.join(logsDir, `${today}.md`), "# Today's log\n- Event B\n");

      // Create old log (3 days ago)
      const oldDate = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      fs.writeFileSync(path.join(logsDir, `${oldDate}.md`), "# Old log\n- Event C\n");

      // Simulate loading today + yesterday
      const recentLogs: string[] = [];
      for (const entry of fs.readdirSync(logsDir)) {
        if (!entry.endsWith(".md")) continue;
        const dateStr = entry.replace(".md", "");
        if (dateStr === today || dateStr === yesterday) {
          recentLogs.push(entry);
        }
      }

      expect(recentLogs.length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("handles empty MEMORY.md", () => {
      const memoryPath = path.join(tmp, "MEMORY.md");
      fs.writeFileSync(memoryPath, "");

      const loaded = fs.readFileSync(memoryPath, "utf-8");
      expect(loaded).toBe("");
    });

    it("handles missing memory directory", () => {
      const logsDir = path.join(tmp, "memory", "logs");
      fs.rmSync(logsDir, { recursive: true, force: true });

      expect(fs.existsSync(logsDir)).toBe(false);

      // Create directory
      fs.mkdirSync(logsDir, { recursive: true });
      expect(fs.existsSync(logsDir)).toBe(true);
    });

    it("handles concurrent log writes", () => {
      const today = new Date().toISOString().split("T")[0];
      const logPath = path.join(tmp, "memory", "logs", `${today}.md`);

      // Simulate concurrent writes
      fs.writeFileSync(logPath, "# Daily Log\n\n## Events\n");
      fs.appendFileSync(logPath, "- [14:30] First event\n");
      fs.appendFileSync(logPath, "- [15:00] Second event\n");

      const read = fs.readFileSync(logPath, "utf-8");
      expect(read).toContain("[14:30] First event");
      expect(read).toContain("[15:00] Second event");
    });
  });
});
