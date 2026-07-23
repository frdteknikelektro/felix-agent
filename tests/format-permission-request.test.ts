import { describe, expect, it } from "vitest";
import { createMattermostAdapter } from "../src/adapters/mattermost/index.js";
import { createDiscordAdapter } from "../src/adapters/discord/index.js";
import { createSlackAdapter } from "../src/adapters/slack/index.js";
import { makeTestConfig } from "./helpers/workspace.js";

const input = {
  skillId: "general",
  permissions: ["shell.run", "general.write"],
  reason: "User asked to run a shell command",
  requesterName: "John",
  requesterId: "user-123",
  threadLink: "https://example.com/thread/1",
};

describe.each(["mattermost", "discord"] as const)("%s formatOwnerNotification", (source) => {
  it("includes all fields with thread link", async () => {
    const cfg = await makeTestConfig(`format-test-${source}`);
    const adapter = source === "mattermost" ? createMattermostAdapter(cfg) : createDiscordAdapter(cfg);
    const text = await adapter.formatOwnerNotification(input);
    expect(text).toContain("**Permission Request**");
    expect(text).toContain("| Field | Value |");
    expect(text).toContain("|---|---|");
    expect(text).toContain("**John** (`user-123`)");
    expect(text).toContain("`general`");
    expect(text).toContain("`shell.run`, `general.write`");
    expect(text).toContain("User asked to run a shell command");
    expect(text).toContain("| **Status** | `pending` |");
    expect(text).toContain("[Open Thread](https://example.com/thread/1)");
    expect(text).toContain("`yes`");
    expect(text).toContain("`always`");
    expect(text).toContain("`no`");
    expect(text).toContain("👌");
    expect(text).toContain("👍");
    expect(text).toContain("🙏");
  });

  it("omits Thread row when threadLink is undefined", async () => {
    const cfg = await makeTestConfig(`format-test-omit-${source}`);
    const adapter = source === "mattermost" ? createMattermostAdapter(cfg) : createDiscordAdapter(cfg);
    const text = await adapter.formatOwnerNotification({ ...input, threadLink: undefined });
    expect(text).not.toContain("Thread");
    expect(text).not.toContain("Open Thread");
  });

  it("formats single permission", async () => {
    const cfg = await makeTestConfig(`format-test-single-${source}`);
    const adapter = source === "mattermost" ? createMattermostAdapter(cfg) : createDiscordAdapter(cfg);
    const text = await adapter.formatOwnerNotification({ ...input, permissions: ["shell.run"] });
    expect(text).toContain("`shell.run`");
  });

  it("renders reason as-is without escaping", async () => {
    const cfg = await makeTestConfig(`format-test-escape-${source}`);
    const adapter = source === "mattermost" ? createMattermostAdapter(cfg) : createDiscordAdapter(cfg);
    const text = await adapter.formatOwnerNotification({ ...input, reason: "Needs access to <repo>" });
    expect(text).toContain("Needs access to <repo>");
  });
});

describe("slack formatOwnerNotification", () => {
  // Slack has no pipe-table rendering at all — the shared table is converted
  // to plain `**Field** Value` lines (see convertNotificationTableToPlainLines).
  it("includes all fields with thread link, table converted to plain lines", async () => {
    const cfg = await makeTestConfig("format-test-slack");
    const adapter = createSlackAdapter(cfg);
    const text = await adapter.formatOwnerNotification(input);
    expect(text).toContain("**Permission Request**");
    expect(text).not.toContain("| Field | Value |");
    expect(text).not.toContain("|---|---|");
    expect(text).toContain("**Requester** **John** (`user-123`)");
    expect(text).toContain("**Skill** `general`");
    expect(text).toContain("**Permissions** `shell.run`, `general.write`");
    expect(text).toContain("**Reason** User asked to run a shell command");
    expect(text).toContain("**Status** `pending`");
    expect(text).toContain("**Thread** [Open Thread](https://example.com/thread/1)");
    expect(text).toContain("`yes`");
    expect(text).toContain("`always`");
    expect(text).toContain("`no`");
    expect(text).toContain("👌");
    expect(text).toContain("👍");
    expect(text).toContain("🙏");
  });

  it("omits Thread row when threadLink is undefined", async () => {
    const cfg = await makeTestConfig("format-test-omit-slack");
    const adapter = createSlackAdapter(cfg);
    const text = await adapter.formatOwnerNotification({ ...input, threadLink: undefined });
    expect(text).not.toContain("Thread");
    expect(text).not.toContain("Open Thread");
  });

  it("formats single permission", async () => {
    const cfg = await makeTestConfig("format-test-single-slack");
    const adapter = createSlackAdapter(cfg);
    const text = await adapter.formatOwnerNotification({ ...input, permissions: ["shell.run"] });
    expect(text).toContain("`shell.run`");
  });

  it("renders reason as-is without escaping", async () => {
    const cfg = await makeTestConfig("format-test-escape-slack");
    const adapter = createSlackAdapter(cfg);
    const text = await adapter.formatOwnerNotification({ ...input, reason: "Needs access to <repo>" });
    expect(text).toContain("Needs access to <repo>");
  });
});
