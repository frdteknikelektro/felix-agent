import path from "node:path";
import type { AppConfig } from "../../config.js";
import { ensureDir, pathExists, readText, writeTextAtomic } from "../../lib/fs.js";
import { parseFrontmatter, renderFrontmatter } from "../../lib/markdown.js";
import type { ContactRecord, SourceSender } from "../../types.js";

interface ContactFrontmatter {
  source?: string;
  user_id?: string;
  display?: string;
  username?: string;
  allowed_permissions?: string[];
  notes?: string;
}

export function contactPath(cfg: AppConfig, source: string, userId: string): string {
  return path.join(cfg.paths.contacts, source, `${safeFileName(userId)}.md`);
}

export async function loadContact(
  cfg: AppConfig,
  source: string,
  userId: string,
): Promise<ContactRecord> {
  const file = contactPath(cfg, source, userId);
  await ensureDir(path.dirname(file));
  if (!(await pathExists(file))) {
    return {
      source,
      user_id: userId,
      allowed_permissions: [],
    };
  }
  const raw = await readText(file);
  const { frontmatter, body } = parseFrontmatter<ContactFrontmatter>(raw);
  return {
    source,
    user_id: userId,
    display: frontmatter.display,
    username: frontmatter.username,
    allowed_permissions: normalizeList(frontmatter.allowed_permissions),
    notes: normalizeNotes(frontmatter.notes, body),
  };
}

export async function saveContact(cfg: AppConfig, contact: ContactRecord): Promise<void> {
  const file = contactPath(cfg, contact.source, contact.user_id);
  await ensureDir(path.dirname(file));
  const frontmatter: ContactFrontmatter = {
    source: contact.source,
    user_id: contact.user_id,
    display: contact.display,
    username: contact.username,
    allowed_permissions: contact.allowed_permissions,
    notes: contact.notes,
  };
  await writeTextAtomic(file, renderFrontmatter(frontmatter, contact.notes ? `\n${contact.notes}\n` : "\n"));
}

/**
 * Additively grant a contact one skill and a set of permissions, de-duplicated
 * against whatever they already hold. This is the single home for the
 * "approved permissions accumulate" invariant — the engine calls it after an
 * "always" decision; nothing else merges contact grants.
 */
export async function grantPermissions(
  cfg: AppConfig,
  requester: SourceSender,
  permissions: string[],
): Promise<ContactRecord> {
  const current = await loadContact(cfg, requester.source, requester.id);
  const next: ContactRecord = {
    ...current,
    source: requester.source,
    user_id: requester.id,
    display: requester.display ?? current.display,
    username: requester.username ?? current.username,
    allowed_permissions: dedup([...current.allowed_permissions, ...permissions]),
  };
  await saveContact(cfg, next);
  return next;
}

function dedup(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNotes(frontmatterNotes: unknown, body: string): string | undefined {
  const fromFrontmatter = typeof frontmatterNotes === "string" ? frontmatterNotes.trim() : "";
  const fromBody = body.trim();
  const notes = fromFrontmatter || fromBody;
  return notes.length > 0 ? notes : undefined;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
