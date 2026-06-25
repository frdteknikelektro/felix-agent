import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { pathExists, readJson, writeJsonAtomic, ensureDir } from "./lib/fs.js";
import { log } from "./lib/log.js";

// ---------------------------------------------------------------------------
// One-time workspace layout migration
//
// The workspace was remounted as $HOME and the `records/` layer was flattened:
//   records/{sessions,approvals,audit.jsonl,bot_messages} → workspace root
//   runtime/wacli                                          → $HOME/.local/state/wacli
//
// Existing deployments still have data under the old layout. This migration
// moves it into place and rewrites the absolute paths persisted inside session
// and approval records. It is triggered by the presence of the legacy
// `<root>/records` directory (the current `ensureWorkspace` never creates it),
// which makes it naturally idempotent and self-removing.
// ---------------------------------------------------------------------------

const RECORDS_CHILDREN = ["sessions", "approvals", "audit.jsonl"] as const;

/** Re-root an absolute path that points into the legacy `…/records/sessions/…`
 *  location onto the new sessions dir. No-op (returns null) if it doesn't match,
 *  which makes path rewriting idempotent. */
function rerootSessionPath(cfg: AppConfig, old: string): string | null {
  const m = old.match(/[\\/]records[\\/]sessions[\\/](.+)$/);
  if (!m) return null;
  return path.join(cfg.paths.sessions, m[1]);
}

/** Move `src` to `dst`, falling back to recursive copy+remove across devices. */
async function move(src: string, dst: string): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(src, dst, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

/** Move the contents of `src` into existing `dst`, entry by entry (used when a
 *  partial prior run already created `dst`). */
async function mergeInto(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src)) {
    const from = path.join(src, entry);
    const to = path.join(dst, entry);
    if (await pathExists(to)) {
      const stat = await fs.stat(from);
      if (stat.isDirectory()) {
        await mergeInto(from, to);
        continue;
      }
      // Existing target file wins — don't clobber post-migration data.
      continue;
    }
    await move(from, to);
  }
  await fs.rm(src, { recursive: true, force: true });
}

async function moveRecordsChildren(cfg: AppConfig, recordsDir: string): Promise<void> {
  for (const child of RECORDS_CHILDREN) {
    const src = path.join(recordsDir, child);
    if (!(await pathExists(src))) continue;
    const dst = path.join(cfg.paths.root, child);
    if (await pathExists(dst)) {
      const stat = await fs.stat(src);
      if (stat.isDirectory()) await mergeInto(src, dst);
      // A bare file (audit.jsonl) whose target already exists: keep target.
    } else {
      await move(src, dst);
    }
    log.info("migration.moved", { from: src, to: dst });
  }
}

/** Rewrite the legacy absolute paths embedded in session.json files. */
async function rewriteSessionPaths(cfg: AppConfig): Promise<void> {
  const sessions = cfg.paths.sessions;
  if (!(await pathExists(sessions))) return;
  for (const source of await fs.readdir(sessions)) {
    const sourceDir = path.join(sessions, source);
    if (!(await fs.stat(sourceDir)).isDirectory()) continue;
    for (const threadDir of await fs.readdir(sourceDir)) {
      const file = path.join(sourceDir, threadDir, "session.json");
      if (!(await pathExists(file))) continue;
      const record = await readJson<Record<string, unknown> | null>(file, null);
      if (!record) continue;
      let changed = false;

      const queue = record.queue;
      if (Array.isArray(queue)) {
        for (const item of queue) {
          if (item && typeof item.event_file === "string") {
            const next = rerootSessionPath(cfg, item.event_file);
            if (next && next !== item.event_file) {
              item.event_file = next;
              changed = true;
            }
          }
        }
      }

      const pending = record.pending_permission as Record<string, unknown> | undefined;
      if (pending && typeof pending.requester_event_file === "string") {
        const next = rerootSessionPath(cfg, pending.requester_event_file);
        if (next && next !== pending.requester_event_file) {
          pending.requester_event_file = next;
          changed = true;
        }
      }

      if (changed) await writeJsonAtomic(file, record);
    }
  }
}

/** Rewrite the legacy absolute paths embedded in approval records. */
async function rewriteApprovalPaths(cfg: AppConfig): Promise<void> {
  const approvals = cfg.paths.approvals;
  if (!(await pathExists(approvals))) return;
  for (const threadKey of await fs.readdir(approvals)) {
    const threadDir = path.join(approvals, threadKey);
    if (!(await fs.stat(threadDir)).isDirectory()) continue;
    for (const entry of await fs.readdir(threadDir)) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(threadDir, entry);
      const record = await readJson<Record<string, unknown> | null>(file, null);
      if (!record) continue;
      let changed = false;
      for (const field of ["requestPath", "decisionPath"] as const) {
        const value = record[field];
        if (typeof value === "string") {
          const next = rerootSessionPath(cfg, value);
          if (next && next !== value) {
            record[field] = next;
            changed = true;
          }
        }
      }
      if (changed) await writeJsonAtomic(file, record);
    }
  }
}

/** Move the wacli WhatsApp store from the old custom location to the default
 *  `$HOME/.local/state/wacli`, preserving the device link. */
async function relocateWacliStore(cfg: AppConfig): Promise<void> {
  const home = process.env.HOME;
  if (!home) return;
  const src = path.join(cfg.paths.runtime, "wacli");
  const dst = path.join(home, ".local", "state", "wacli");
  if (!(await pathExists(src)) || (await pathExists(dst))) return;
  await move(src, dst);
  log.info("migration.wacli_relocated", { from: src, to: dst });
}

/** Move the legacy `bot_messages/` dir to `index/bot-messages/`. */
async function moveBotMessages(cfg: AppConfig, recordsDir?: string): Promise<void> {
  const src = path.join(cfg.paths.root, "bot_messages");
  const legacySrc = recordsDir ? path.join(recordsDir, "bot_messages") : null;
  const realSrc = legacySrc && (await pathExists(legacySrc)) ? legacySrc : (await pathExists(src) ? src : null);
  if (!realSrc) return;
  const dst = cfg.paths.botMessageIndex;
  await ensureDir(path.dirname(dst));
  if (await pathExists(dst)) {
    await mergeInto(realSrc, dst);
  } else {
    await move(realSrc, dst);
  }
  log.info("migration.bot_messages_moved", { from: realSrc, to: dst });
}

export async function migrateWorkspaceLayout(cfg: AppConfig): Promise<void> {
  const recordsDir = path.join(cfg.paths.root, "records");
  const hasLegacyRecords = await pathExists(recordsDir);
  // The wacli relocation can apply independently of the records dir.
  if (!hasLegacyRecords) {
    await relocateWacliStore(cfg);
    return;
  }

  try {
    log.info("migration.starting", { records_dir: recordsDir });
    await moveRecordsChildren(cfg, recordsDir);
    await moveBotMessages(cfg, recordsDir);
    await rewriteSessionPaths(cfg);
    await rewriteApprovalPaths(cfg);
    await relocateWacliStore(cfg);
    // Removing the (now-empty) records dir is what prevents a re-run.
    await fs.rm(recordsDir, { recursive: true, force: true });
    log.info("migration.completed", { records_dir: recordsDir });
  } catch (err) {
    log.error("migration.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
