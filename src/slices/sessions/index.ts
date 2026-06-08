import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readJson, readJsonParsed, readText, safeFileName, writeJsonAtomic, writeTextAtomic } from "../../lib/fs.js";
import { fsTimestamp, safeTimestamp } from "../../lib/time.js";
import { parseFrontmatter, renderFrontmatter } from "../../lib/markdown.js";
import { buildEventFile, type EventFileSpec, type OwnerPermissionDetails } from "../events/index.js";
import { ThreadStateSchema, SessionStateSchema } from "../../core/schemas.js";
import type {
  SessionPermissionRequest,
  SessionQueueItem,
  SessionState,
  ThreadState,
  UniversalEvent,
} from "../../types.js";
import { sourceSessionsDir, sourceThreadKeyIndexDir } from "../../workspace.js";

export interface ThreadHandle {
  dir: string;
  threadFile: string;
  sessionFile: string;
  transcriptFile: string;
  eventsDir: string;
  attachmentsDir: string;
  turnsDir: string;
  state: ThreadState;
  session: SessionState;
}

export async function createOrLoadThread(
  cfg: AppConfig,
  event: Pick<UniversalEvent, "source" | "thread_key" | "source_thread_ref" | "received_at">,
): Promise<ThreadHandle> {
  const existing = await findThreadHandle(cfg, event.thread_key, event.source);
  if (existing) {
    await touchThread(existing);
    return existing;
  }

  const createdAt = event.received_at;
  const dir = path.join(sourceSessionsDir(cfg.paths, event.source), buildThreadDirName(event.thread_key, createdAt));
  const threadFile = path.join(dir, "thread.json");
  const sessionFile = path.join(dir, "session.json");
  const transcriptFile = path.join(dir, "transcript.md");
  const eventsDir = path.join(dir, "events");
  const attachmentsDir = path.join(dir, "attachments");
  const turnsDir = path.join(dir, "turns");
  await ensureDir(dir);
  await Promise.all([ensureDir(eventsDir), ensureDir(attachmentsDir), ensureDir(turnsDir)]);

  const state: ThreadState = {
    thread_key: event.thread_key,
    source: event.source,
    created_at: createdAt,
    updated_at: createdAt,
    managed_by_felix: true,
    source_thread_ref: event.source_thread_ref,
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
  const handle = {
    dir,
    threadFile,
    sessionFile,
    transcriptFile,
    eventsDir,
    attachmentsDir,
    turnsDir,
    state,
    session,
  };
  await writeThreadKeyIndex(cfg, handle);
  return handle;
}

export async function findThreadHandle(
  cfg: AppConfig,
  threadKey: string,
  source?: string,
): Promise<ThreadHandle | null> {
  const sources = source ? [source] : await listThreadKeyIndexSources(cfg);
  const indexName = `${safeFileName(threadKey)}.json`;
  for (const candidateSource of sources) {
    const indexFile = path.join(sourceThreadKeyIndexDir(cfg.paths, candidateSource), indexName);
    const index = await readJson<ThreadKeyIndexRecord | null>(indexFile, null);
    if (!index || index.thread_key !== threadKey) continue;
    const dir = path.resolve(cfg.paths.root, index.session_path);
    const handle = await loadThreadHandleByDir(dir);
    if (handle?.state.thread_key === threadKey) return handle;
  }
  return null;
}

export async function listThreadHandles(cfg: AppConfig): Promise<ThreadHandle[]> {
  const out: ThreadHandle[] = [];
  const sources = await fs.readdir(cfg.paths.sessions, { withFileTypes: true }).catch(() => []);
  for (const sourceDirEntry of sources) {
    if (!sourceDirEntry.isDirectory()) continue;
    const sourcePath = path.join(cfg.paths.sessions, sourceDirEntry.name);
    const candidates = await fs.readdir(sourcePath, { withFileTypes: true }).catch(() => []);
    for (const candidate of candidates) {
      if (!candidate.isDirectory()) continue;
      const dir = path.join(sourcePath, candidate.name);
      const threadFile = path.join(dir, "thread.json");
      if (!(await pathExists(threadFile))) continue;
      const state = await repairThreadState(cfg, dir, await readJsonParsed(threadFile, ThreadStateSchema, null as unknown as ThreadState));
      if (!state) continue;
      const handle = await loadThreadHandle(dir, state);
      await writeThreadKeyIndex(cfg, handle);
      out.push(handle);
    }
  }
  return out;
}

export async function loadThreadHandleByDir(dir: string): Promise<ThreadHandle | null> {
  const threadFile = path.join(dir, "thread.json");
  if (!(await pathExists(threadFile))) return null;
  const state = await readJsonParsed(threadFile, ThreadStateSchema, null as unknown as ThreadState);
  if (!state) return null;
  return loadThreadHandle(dir, state);
}

async function writeThreadEventAt(handle: ThreadHandle, file: string, spec: EventFileSpec): Promise<string> {
  await writeTextAtomic(file, renderFrontmatter(spec.frontmatter, spec.body));
  const lines = [...spec.transcriptLines, "", `Event file: ${path.relative(handle.dir, file)}`, ""];
  await appendTranscript(handle, (spec.compactTranscript ? lines.filter(Boolean) : lines).join("\n"));
  return file;
}

async function writeThreadEvent(handle: ThreadHandle, spec: EventFileSpec): Promise<string> {
  const file = path.join(handle.eventsDir, `${safeTimestamp(new Date(spec.at))}_${spec.slug}.md`);
  return writeThreadEventAt(handle, file, spec);
}

export async function appendEventToThread(handle: ThreadHandle, event: UniversalEvent): Promise<string> {
  return writeThreadEvent(handle, buildEventFile({ kind: "source_event", event }));
}

export async function appendFelixReply(
  handle: ThreadHandle,
  at: string,
  text: string,
  codexSessionId?: string,
): Promise<string> {
  return writeThreadEvent(handle, buildEventFile({ kind: "felix_reply", at, text, codexSessionId }));
}

export async function appendPermissionEvent(
  handle: ThreadHandle,
  at: string,
  decision: "approved" | "rejected",
  details: OwnerPermissionDetails,
): Promise<string> {
  return writeThreadEvent(
    handle,
    buildEventFile({
      kind: "owner_permission",
      at,
      source: handle.state.source,
      threadKey: handle.state.thread_key,
      decision,
      details,
    }),
  );
}

export async function appendPermissionRequest(
  handle: ThreadHandle,
  request: SessionPermissionRequest,
): Promise<string> {
  return writeThreadEventAt(
    handle,
    request.requester_event_file,
    buildEventFile({ kind: "permission_request", request }),
  );
}

export async function loadSessionState(handle: ThreadHandle): Promise<SessionState> {
  return readJsonParsed(handle.sessionFile, SessionStateSchema, {
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
  return readJsonParsed(handle.threadFile, ThreadStateSchema, handle.state);
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

export async function setThreadBusy(handle: ThreadHandle, busy: boolean): Promise<SessionState> {
  const session = await loadSessionState(handle);
  session.busy = busy;
  await saveSessionState(handle, session);
  return session;
}

export interface ShiftedEvent {
  item: SessionQueueItem;
  session: SessionState;
}

export async function shiftNextEvent(handle: ThreadHandle): Promise<ShiftedEvent | null> {
  const session = await loadSessionState(handle);
  const item = session.queue.shift();
  if (!item) return null;
  await saveSessionState(handle, session);
  return { item, session };
}

export async function requeueEvent(
  handle: ThreadHandle,
  item: SessionQueueItem,
  opts: { clearCodexSession?: boolean } = {},
): Promise<SessionState> {
  const session = await loadSessionState(handle);
  session.queue.unshift(item);
  if (opts.clearCodexSession) delete session.codex_session_id;
  await saveSessionState(handle, session);
  return session;
}

export async function recordTurn(handle: ThreadHandle, codexSessionId: string): Promise<SessionState> {
  const session = await loadSessionState(handle);
  session.codex_session_id = codexSessionId;
  session.last_turn_at = new Date().toISOString();
  await saveSessionState(handle, session);
  return session;
}

export async function clearCodexSession(handle: ThreadHandle): Promise<SessionState> {
  const session = await loadSessionState(handle);
  delete session.codex_session_id;
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
  state = await repairThreadStateByDir(dir, state);
  const threadFile = path.join(dir, "thread.json");
  const sessionFile = path.join(dir, "session.json");
  const transcriptFile = path.join(dir, "transcript.md");
  const eventsDir = path.join(dir, "events");
  const attachmentsDir = path.join(dir, "attachments");
  const turnsDir = path.join(dir, "turns");
  const session = await readJsonParsed(sessionFile, SessionStateSchema, {
    busy: false,
    queue: [],
    pending_permission: null,
  });
  await Promise.all([ensureDir(eventsDir), ensureDir(attachmentsDir), ensureDir(turnsDir)]);
  return {
    dir,
    threadFile,
    sessionFile,
    transcriptFile,
    eventsDir,
    attachmentsDir,
    turnsDir,
    state,
    session,
  };
}

function buildThreadDirName(threadKey: string, createdAt: string): string {
  return `${safeTimestamp(new Date(createdAt))}_${safeFileName(threadKey).slice(0, 120)}`;
}

async function repairThreadState(cfg: AppConfig, dir: string, state: ThreadState): Promise<ThreadState> {
  const repaired = await repairThreadStateByDir(dir, state);
  if (repaired !== state) {
    await writeThreadKeyIndex(cfg, await loadThreadHandle(dir, repaired));
  }
  return repaired;
}

async function repairThreadStateByDir(dir: string, state: ThreadState): Promise<ThreadState> {
  const rootId = state.source_thread_ref.root_message_id?.trim();
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
    const sourceThread = parsed.frontmatter.source_thread_ref as Record<string, unknown> | undefined;
    const channelId = typeof sourceThread?.conversation_id === "string" ? sourceThread.conversation_id.trim() : "";
    if (!eventId || !channelId) continue;
    const repaired: ThreadState = {
      ...state,
      thread_key: `mattermost:${channelId}:${eventId}`,
      source_thread_ref: {
        ...state.source_thread_ref,
        source: "mattermost",
        conversation_id: channelId,
        root_message_id: eventId,
        thread_id: eventId,
      },
      updated_at: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(dir, "thread.json"), repaired);
    return repaired;
  }

  return state;
}

interface ThreadKeyIndexRecord {
  thread_key: string;
  source: string;
  session_path: string;
}

async function writeThreadKeyIndex(cfg: AppConfig, handle: ThreadHandle): Promise<void> {
  const file = path.join(
    sourceThreadKeyIndexDir(cfg.paths, handle.state.source),
    `${safeFileName(handle.state.thread_key)}.json`,
  );
  const record: ThreadKeyIndexRecord = {
    thread_key: handle.state.thread_key,
    source: handle.state.source,
    session_path: path.relative(cfg.paths.root, handle.dir),
  };
  await writeJsonAtomic(file, record);
}

async function listThreadKeyIndexSources(cfg: AppConfig): Promise<string[]> {
  const entries = await fs.readdir(cfg.paths.threadKeyIndex, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
