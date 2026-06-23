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
    SECRET_ENV_FILE: "/run/secrets/.env",
    CODEX_BIN: "codex",
    CODEX_MODEL: "gpt-5.4-mini",
    CODEX_BYPASS_SANDBOX: true,
    CODEX_REASONING_EFFORT: "high",
    CODEX_TIMEOUT_SECONDS: 1800,
    HARNESS: "codex" as const,
    OPENCODE_BIN: "opencode",
    OPENCODE_MODEL: "opencode/deepseek-v4-flash-free",
    OPENCODE_VARIANT: "high",
    CLAUDE_CODE_BIN: "claude",
    CLAUDE_CODE_MODEL: "sonnet",
    CLAUDE_CODE_TIMEOUT_MS: 300000,
    OPENAI_CODEX_AUTH_JSON: undefined,
    MATTERMOST_BOT_DISPLAY: "Felix",
    MATTERMOST_OWNER_DISPLAY: "Owner",
    DISCORD_OWNER_DISPLAY: "Owner",
    SLACK_OWNER_DISPLAY: "Owner",
    WHATSAPP_BOT_NAME: undefined,
    WHATSAPP_OWNER_JID: undefined,
    WHATSAPP_OWNER_DISPLAY: "Owner",
    WHATSAPP_WACLI_BIN: "wacli",
    WHATSAPP_STORE_DIR: "",
    WHATSAPP_WEBHOOK_SECRET: "",
    WHATSAPP_MAX_MESSAGES: 5000,
    WHATSAPP_MAX_DB_SIZE: "100MB",
    SOURCE: "mattermost",
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
