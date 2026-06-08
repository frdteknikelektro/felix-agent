import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkspacePaths } from "../../src/workspace.js";
import type { AppConfig } from "../../src/config.js";
import type { SourceThreadRef } from "../../src/types.js";

export async function makeTestConfig(prefix: string, extras: Partial<AppConfig> = {}): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  return {
    WORKSPACE_DIR: workspace,
    CONFIG_DIR: "/config",
    SECRET_ENV_FILE: "/run/secrets/.env",
    HEALTH_PORT: 3000,
    CODEX_BIN: "codex",
    CODEX_MODEL: "gpt-5.4-mini",
    CODEX_BYPASS_SANDBOX: true,
    CODEX_TIMEOUT_SECONDS: 1800,
    MATTERMOST_BOT_DISPLAY: "Felix",
    MATTERMOST_OWNER_DISPLAY: "Owner",
    SOURCE: "mattermost",
    THREAD_SCAN_INTERVAL_MS: 1000,
    paths: buildWorkspacePaths(workspace),
    ...extras,
  } as AppConfig;
}

export function mattermostThreadRef(
  conversationId = "chan",
  rootMessageId = "root",
  messageId = rootMessageId,
): SourceThreadRef {
  return {
    source: "mattermost",
    conversation_id: conversationId,
    thread_id: rootMessageId,
    root_message_id: rootMessageId,
    message_id: messageId,
    raw: {
      channel_id: conversationId,
      root_id: rootMessageId,
    },
  };
}
