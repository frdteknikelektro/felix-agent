import fs from "node:fs/promises";
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
  alias?: string;
  allowed_permissions?: string[];
  notes?: string;
}

export type ContactEditorErrorCode = "contact_missing" | "contact_exists";

export class ContactEditorError extends Error {
  constructor(public readonly code: ContactEditorErrorCode) {
    super(code);
  }
}

export interface ContactEditorInput {
  display?: unknown;
  username?: unknown;
  alias?: unknown;
  allowed_permissions?: unknown;
  notes?: unknown;
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
    alias: frontmatter.alias,
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
    alias: contact.alias,
    allowed_permissions: contact.allowed_permissions,
    notes: contact.notes,
  };
  await writeTextAtomic(file, renderFrontmatter(frontmatter, contact.notes ? `\n${contact.notes}\n` : "\n"));
}

export async function listContacts(cfg: AppConfig): Promise<ContactRecord[]> {
  const entries = await fs.readdir(cfg.paths.contacts, { withFileTypes: true }).catch(() => []);
  const out: ContactRecord[] = [];
  for (const sourceEntry of entries) {
    if (!sourceEntry.isDirectory()) continue;
    const source = sourceEntry.name;
    const sourceDir = path.join(cfg.paths.contacts, source);
    const files = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const userId = file.name.slice(0, -3);
      const contact = await loadContact(cfg, source, userId);
      if (!(await pathExists(contactPath(cfg, source, userId)))) continue;
      out.push(contact);
    }
  }
  return out.sort((a, b) => `${a.source}:${a.user_id}`.localeCompare(`${b.source}:${b.user_id}`));
}

export async function loadContactForEditor(
  cfg: AppConfig,
  source: string,
  userId: string,
): Promise<ContactRecord | null> {
  const file = contactPath(cfg, source, userId);
  if (!(await pathExists(file))) return null;
  return loadContact(cfg, source, userId);
}

export async function updateContactFromEditor(
  cfg: AppConfig,
  source: string,
  userId: string,
  input: ContactEditorInput,
): Promise<ContactRecord> {
  const current = await loadContactForEditor(cfg, source, userId);
  if (!current) {
    throw new ContactEditorError("contact_missing");
  }
  const next: ContactRecord = {
    ...current,
    ...contactEditorPatch(input),
    source,
    user_id: userId,
  };
  await saveContact(cfg, next);
  return next;
}

export async function createContactFromEditor(
  cfg: AppConfig,
  source: string,
  userId: string,
  input: ContactEditorInput,
): Promise<ContactRecord> {
  const file = contactPath(cfg, source, userId);
  if (await pathExists(file)) {
    throw new ContactEditorError("contact_exists");
  }
  const next: ContactRecord = {
    ...contactEditorPatch(input),
    source,
    user_id: userId,
  };
  await saveContact(cfg, next);
  return next;
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

type ContactEditorPatch = Partial<Omit<ContactRecord, "source" | "user_id">> & {
  allowed_permissions: string[];
};

function contactEditorPatch(input: ContactEditorInput): ContactEditorPatch {
  const patch: ContactEditorPatch = {
    display: optionalString(input.display),
    username: optionalString(input.username),
    allowed_permissions: normalizeEditorList(input.allowed_permissions),
    notes: optionalString(input.notes),
  };
  if (Object.prototype.hasOwnProperty.call(input, "alias")) {
    patch.alias = optionalString(input.alias);
  }
  return patch;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEditorList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedup(value.map((item) => String(item).trim()).filter(Boolean));
  }
  if (typeof value === "string") {
    return dedup(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  return [];
}

function normalizeNotes(frontmatterNotes: unknown, body: string): string | undefined {
  const fromFrontmatter = typeof frontmatterNotes === "string" ? frontmatterNotes.trim() : "";
  const fromBody = body.trim();
  const notes = fromFrontmatter || fromBody;
  return notes.length > 0 ? notes : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
