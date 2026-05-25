import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { ensureDir, pathExists, readJson, readText, writeJsonAtomic, writeTextAtomic } from "./lib/fs.js";
import { fsTimestamp, safeTimestamp } from "./lib/time.js";
import { parseFrontmatter, renderFrontmatter } from "./lib/markdown.js";
import type {
  SessionPermissionRequest,
  SessionQueueItem,
  SessionState,
  ThreadState,
  UniversalAttachment,
  UniversalEvent,
} from "./types.js";
import { sourceDir } from "./workspace.js";

export interface ThreadHandle {
  dir: string;
  threadFile: string;
  sessionFile: string;
  transcriptFile: string;
  eventsDir: string;
  mediaDir: string;
  codexDir: string;
  state: ThreadState;
  session: SessionState;
}

export async function createOrLoadThread(
  cfg: AppConfig,
  event: Pick<UniversalEvent, "source" | "thread_key" | "source_thread" | "received_at">,
): Promise<ThreadHandle> {
  const existing = await findThreadHandle(cfg, event.thread_key);
  if (existing) {
    await touchThread(existing);
    return existing;
  }

  const createdAt = event.received_at;
  const dir = path.join(sourceDir(cfg.paths, event.source), buildThreadDirName(event.thread_key, createdAt));
  const threadFile = path.join(dir, "thread.json");
  const sessionFile = path.join(dir, "session.json");
  const transcriptFile = path.join(dir, "transcript.md");
  const eventsDir = path.join(dir, "events");
  const mediaDir = path.join(dir, "media");
  const codexDir = path.join(dir, "codex");
  await ensureDir(dir);
  await Promise.all([ensureDir(eventsDir), ensureDir(mediaDir), ensureDir(codexDir)]);

  const state: ThreadState = {
    thread_key: event.thread_key,
    source: event.source,
    created_at: createdAt,
    updated_at: createdAt,
    managed_by_felix: true,
    source_thread: event.source_thread,
    participants: [],
  };
  const session: SessionState = {
    busy: false,
    queue: [],
    pending_permission: null,
  };

  await writeJsonAtomic(threadFile, state);
  await writeJsonAtomic(sessionFile, session);
  await writeTextAtomic(transcriptFile, `# Thread ${event.thread_key}\n\nCreated ${createdAt}\n`);
  return {
    dir,
    threadFile,
    sessionFile,
    transcriptFile,
    eventsDir,
    mediaDir,
    codexDir,
    state,
    session,
  };
}

export async function findThreadHandle(
  cfg: AppConfig,
  threadKey: string,
): Promise<ThreadHandle | null> {
  const sources = await fs.readdir(cfg.paths.threads, { withFileTypes: true }).catch(() => []);
  for (const sourceDirEntry of sources) {
    if (!sourceDirEntry.isDirectory()) continue;
    const sourcePath = path.join(cfg.paths.threads, sourceDirEntry.name);
    const candidates = await fs.readdir(sourcePath, { withFileTypes: true }).catch(() => []);
    for (const candidate of candidates) {
      if (!candidate.isDirectory()) continue;
      const dir = path.join(sourcePath, candidate.name);
      const threadFile = path.join(dir, "thread.json");
      if (!(await pathExists(threadFile))) continue;
      const state = await repairThreadState(dir, await readJson<ThreadState>(threadFile, null as unknown as ThreadState));
      if (!state || state.thread_key !== threadKey) continue;
      return loadThreadHandle(dir, state);
    }
  }
  return null;
}

export async function listThreadHandles(cfg: AppConfig): Promise<ThreadHandle[]> {
  const out: ThreadHandle[] = [];
  const sources = await fs.readdir(cfg.paths.threads, { withFileTypes: true }).catch(() => []);
  for (const sourceDirEntry of sources) {
    if (!sourceDirEntry.isDirectory()) continue;
    const sourcePath = path.join(cfg.paths.threads, sourceDirEntry.name);
    const candidates = await fs.readdir(sourcePath, { withFileTypes: true }).catch(() => []);
    for (const candidate of candidates) {
      if (!candidate.isDirectory()) continue;
      const dir = path.join(sourcePath, candidate.name);
      const threadFile = path.join(dir, "thread.json");
      if (!(await pathExists(threadFile))) continue;
      const state = await repairThreadState(dir, await readJson<ThreadState>(threadFile, null as unknown as ThreadState));
      if (!state) continue;
      out.push(await loadThreadHandle(dir, state));
    }
  }
  return out;
}

export async function loadThreadHandleByDir(dir: string): Promise<ThreadHandle | null> {
  const threadFile = path.join(dir, "thread.json");
  if (!(await pathExists(threadFile))) return null;
  const state = await readJson<ThreadState>(threadFile, null as unknown as ThreadState);
  if (!state) return null;
  return loadThreadHandle(dir, state);
}

export async function appendEventToThread(
  handle: ThreadHandle,
  event: UniversalEvent,
): Promise<string> {
  const file = path.join(
    handle.eventsDir,
    `${safeTimestamp(new Date(event.received_at))}_${safeFileName(event.source)}_${safeFileName(event.event_id)}.md`,
  );
  const attachmentLines = event.attachments.length
    ? [
        "",
        "Attachments:",
        ...event.attachments.map((attachment) => `- ${attachment.local_path ?? attachment.filename}`),
      ]
    : [];
  const raw = renderFrontmatter(
    {
      type: "source_event",
      source: event.source,
      event_id: event.event_id,
      thread_key: event.thread_key,
      received_at: event.received_at,
      visibility: event.visibility,
      mentions_bot: event.mentions_bot,
      sender: event.sender,
      source_thread: event.source_thread,
      attachments: event.attachments,
    },
    `${event.text.trim()}\n${attachmentLines.join("\n")}\n`,
  );
  await writeTextAtomic(file, raw);
  await appendTranscript(handle, [
    `### [${event.received_at}] ${event.source}:${event.sender.id}`,
    event.text.trim(),
    ...attachmentLines,
    "",
    `Event file: ${path.relative(handle.dir, file)}`,
    "",
  ].join("\n"));
  return file;
}

export async function appendFelixReply(
  handle: ThreadHandle,
  at: string,
  text: string,
  codexSessionId?: string,
): Promise<string> {
  const file = path.join(handle.eventsDir, `${safeTimestamp(new Date(at))}_felix_reply.md`);
  const raw = renderFrontmatter(
    {
      type: "felix_reply",
      at,
      codex_session_id: codexSessionId,
    },
    `${text.trim()}\n`,
  );
  await writeTextAtomic(file, raw);
  await appendTranscript(handle, [`### [${at}] felix`, text.trim(), "", `Event file: ${path.relative(handle.dir, file)}`, ""].join("\n"));
  return file;
}

export async function appendPermissionEvent(
  handle: ThreadHandle,
  at: string,
  decision: "approved" | "rejected",
  details: {
    owner_user_id?: string;
    skill_id: string;
    permissions: string[];
    scope: "once" | "always";
    source_thread?: {
      channel_id?: string;
      root_id?: string;
      user_id?: string;
    };
    reason?: string;
  },
): Promise<string> {
  const file = path.join(handle.eventsDir, `${safeTimestamp(new Date(at))}_owner_permission_${decision}.md`);
  const raw = renderFrontmatter(
    {
      type: "owner_permission",
      source: handle.state.source,
      thread_key: handle.state.thread_key,
      decision,
      approved_at: at,
      ...details,
    },
    [
      `${decision === "approved" ? "Approved" : "Rejected"} permission for ${details.skill_id}.`,
      `Scope: ${details.scope}`,
      details.reason ? `Reason: ${details.reason}` : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  await writeTextAtomic(file, raw);
  await appendTranscript(
    handle,
    [
      `### [${at}] owner_permission:${decision}`,
      `Skill: ${details.skill_id}`,
      `Scope: ${details.scope}`,
      `Permissions: ${details.permissions.join(", ")}`,
      details.reason ? `Reason: ${details.reason}` : "",
      "",
      `Event file: ${path.relative(handle.dir, file)}`,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return file;
}

export async function loadSessionState(handle: ThreadHandle): Promise<SessionState> {
  return readJson<SessionState>(handle.sessionFile, {
    busy: false,
    queue: [],
    pending_permission: null,
  });
}

export async function saveSessionState(handle: ThreadHandle, session: SessionState): Promise<void> {
  await writeJsonAtomic(handle.sessionFile, session);
  handle.session = session;
}

export async function loadThreadState(handle: ThreadHandle): Promise<ThreadState> {
  return readJson<ThreadState>(handle.threadFile, handle.state);
}

export async function saveThreadState(handle: ThreadHandle, state: ThreadState): Promise<void> {
  await writeJsonAtomic(handle.threadFile, state);
  handle.state = state;
}

export async function queueThreadEvent(
  handle: ThreadHandle,
  item: SessionQueueItem,
): Promise<SessionState> {
  const session = await loadSessionState(handle);
  if (session.queue.some((queued) => queued.source_event_id === item.source_event_id)) {
    return session;
  }
  session.queue.push(item);
  session.last_event_at = item.received_at;
  await saveSessionState(handle, session);
  return session;
}

export async function dequeueThreadEvent(handle: ThreadHandle): Promise<SessionQueueItem | null> {
  const session = await loadSessionState(handle);
  const item = session.queue.shift() ?? null;
  await saveSessionState(handle, session);
  return item;
}

export async function setThreadBusy(handle: ThreadHandle, busy: boolean): Promise<SessionState> {
  const session = await loadSessionState(handle);
  session.busy = busy;
  await saveSessionState(handle, session);
  return session;
}

export async function setThreadCodexSessionId(
  handle: ThreadHandle,
  sessionId: string | undefined,
): Promise<SessionState> {
  const session = await loadSessionState(handle);
  if (sessionId) {
    session.codex_session_id = sessionId;
  } else {
    delete session.codex_session_id;
  }
  await saveSessionState(handle, session);
  return session;
}

export async function setPendingPermission(
  handle: ThreadHandle,
  request: SessionPermissionRequest | null,
): Promise<SessionState> {
  const session = await loadSessionState(handle);
  session.pending_permission = request;
  await saveSessionState(handle, session);
  return session;
}

export async function updateThreadState(
  handle: ThreadHandle,
  patch: Partial<ThreadState>,
): Promise<ThreadState> {
  const state = { ...handle.state, ...patch, updated_at: new Date().toISOString() };
  await saveThreadState(handle, state);
  return state;
}

export async function hasThreadEvent(
  handle: ThreadHandle,
  source: string,
  eventId: string,
): Promise<boolean> {
  const suffix = `_${safeFileName(source)}_${safeFileName(eventId)}.md`;
  const entries = await fs.readdir(handle.eventsDir, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isFile() && entry.name.endsWith(suffix));
}

export async function addParticipant(handle: ThreadHandle, participant: string): Promise<void> {
  const state = await loadThreadState(handle);
  if (state.participants.includes(participant)) return;
  state.participants.push(participant);
  state.updated_at = new Date().toISOString();
  await saveThreadState(handle, state);
}

async function appendTranscript(handle: ThreadHandle, block: string): Promise<void> {
  await fs.appendFile(handle.transcriptFile, `\n${block}\n`, "utf8");
}

async function touchThread(handle: ThreadHandle): Promise<void> {
  await updateThreadState(handle, {});
}

async function loadThreadHandle(dir: string, state: ThreadState): Promise<ThreadHandle> {
  state = await repairThreadState(dir, state);
  const threadFile = path.join(dir, "thread.json");
  const sessionFile = path.join(dir, "session.json");
  const transcriptFile = path.join(dir, "transcript.md");
  const eventsDir = path.join(dir, "events");
  const mediaDir = path.join(dir, "media");
  const codexDir = path.join(dir, "codex");
  const session = await readJson<SessionState>(sessionFile, {
    busy: false,
    queue: [],
    pending_permission: null,
  });
  await Promise.all([ensureDir(eventsDir), ensureDir(mediaDir), ensureDir(codexDir)]);
  return {
    dir,
    threadFile,
    sessionFile,
    transcriptFile,
    eventsDir,
    mediaDir,
    codexDir,
    state,
    session,
  };
}

function buildThreadDirName(threadKey: string, createdAt: string): string {
  return `${safeTimestamp(new Date(createdAt))}_${safeFileName(threadKey).slice(0, 120)}`;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function repairThreadState(dir: string, state: ThreadState): Promise<ThreadState> {
  const rootId = state.source_thread.root_id?.trim();
  if (state.source !== "mattermost" || rootId) {
    return state;
  }

  const eventsDir = path.join(dir, "events");
  const entries = await fs.readdir(eventsDir, { withFileTypes: true }).catch(() => []);
  const eventFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(eventsDir, entry.name))
    .sort();

  for (const file of eventFiles) {
    const raw = await readText(file, "");
    const parsed = parseFrontmatter<Record<string, unknown>>(raw);
    if (parsed.frontmatter.type !== "source_event") continue;
    const eventId = typeof parsed.frontmatter.event_id === "string" ? parsed.frontmatter.event_id.trim() : "";
    const sourceThread = parsed.frontmatter.source_thread as Record<string, unknown> | undefined;
    const channelId = typeof sourceThread?.channel_id === "string" ? sourceThread.channel_id.trim() : "";
    if (!eventId || !channelId) continue;
    const repaired: ThreadState = {
      ...state,
      thread_key: `mattermost:${channelId}:${eventId}`,
      source_thread: {
        ...state.source_thread,
        channel_id: channelId,
        root_id: eventId,
      },
      updated_at: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(dir, "thread.json"), repaired);
    return repaired;
  }

  return state;
}
