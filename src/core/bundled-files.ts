import fs from "node:fs/promises";
import { writeTextAtomic } from "../lib/fs.js";

/**
 * Copy a bundled text file into the workspace once, preserving any user edit
 * made after the first boot. The source is required so packaging mistakes
 * fail during boot instead of silently disabling the feature.
 */
export async function copyTextFileIfAbsent(source: string, destination: string): Promise<"written" | "skipped"> {
  const content = await fs.readFile(source, "utf-8");
  const exists = await fs.stat(destination).then((stat) => stat.isFile()).catch(() => false);
  if (exists) return "skipped";
  await writeTextAtomic(destination, content);
  return "written";
}
