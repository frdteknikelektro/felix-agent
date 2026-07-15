import fs from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readText(file: string, fallback = ""): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return fallback;
  }
}

export async function writeTextAtomic(file: string, text: string, mode?: number): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, text, { encoding: "utf8", mode });
    if (mode !== undefined && process.platform !== "win32") await fs.chmod(tmp, mode);
    await fs.rename(tmp, file);
    if (mode !== undefined && process.platform !== "win32") await fs.chmod(file, mode);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export async function appendText(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, text, "utf8");
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Like readJson but validates against a Zod schema; returns fallback on parse or validation failure. */
export async function readJsonParsed<T>(
  file: string,
  schema: ZodType<T>,
  fallback: T,
): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Sanitize an arbitrary string into a filesystem-safe name segment. */
export function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
