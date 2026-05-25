import path from "node:path";
import type { AppConfig } from "./config.js";
import { ensureDir, pathExists, readText, writeTextAtomic } from "./lib/fs.js";
import { parseFrontmatter, renderFrontmatter } from "./lib/markdown.js";
import type { ContactRecord } from "./types.js";

interface ContactFrontmatter {
  source?: string;
  user_id?: string;
  display?: string;
  username?: string;
  allowed_permissions?: string[];
  allowed_skills?: string[];
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
      allowed_skills: [],
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
    allowed_skills: normalizeList(frontmatter.allowed_skills),
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
    allowed_skills: contact.allowed_skills,
    notes: contact.notes,
  };
  await writeTextAtomic(file, renderFrontmatter(frontmatter, contact.notes ? `\n${contact.notes}\n` : "\n"));
}

export async function upsertContact(
  cfg: AppConfig,
  source: string,
  userId: string,
  patch: Partial<ContactRecord> & { display?: string; username?: string },
): Promise<ContactRecord> {
  const current = await loadContact(cfg, source, userId);
  const next: ContactRecord = {
    ...current,
    ...patch,
    source,
    user_id: userId,
    allowed_permissions: patch.allowed_permissions ?? current.allowed_permissions,
    allowed_skills: patch.allowed_skills ?? current.allowed_skills,
  };
  await saveContact(cfg, next);
  return next;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
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
