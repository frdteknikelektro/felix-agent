import fs from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { UniversalAttachment } from "../types.js";
import { ensureDir, safeFileName } from "../lib/fs.js";
import { fsTimestamp } from "../lib/time.js";

export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export class AttachmentRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "AttachmentRejectedError";
  }
}

export function rejectOversizedAttachment(
  attachment: UniversalAttachment,
  maxBytes: number,
): UniversalAttachment | null {
  if (typeof attachment.size_bytes !== "number" || attachment.size_bytes <= maxBytes) {
    return null;
  }
  return rejectedAttachment(
    attachment,
    `File is ${formatBytes(attachment.size_bytes)}, above the ${formatBytes(maxBytes)} limit.`,
  );
}

export function rejectedAttachment(
  attachment: UniversalAttachment,
  reason: string,
): UniversalAttachment {
  return {
    ...attachment,
    local_path: undefined,
    status: "rejected",
    rejected_reason: reason,
  };
}

export function storedAttachmentPath(
  destinationDir: string,
  receivedAt: string,
  filename: string,
  uniqueId?: string,
): string {
  const safeUniqueId = uniqueId ? `${safeFileName(uniqueId)}_` : "";
  return path.join(destinationDir, `${fsTimestamp(new Date(receivedAt))}_${safeUniqueId}${safeFileName(filename)}`);
}

export async function downloadResponseToFile(
  res: Response,
  destinationFile: string,
  maxBytes: number,
): Promise<number> {
  const contentLength = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AttachmentRejectedError(
      `attachment exceeds ${formatBytes(maxBytes)}`,
      `File is ${formatBytes(contentLength)}, above the ${formatBytes(maxBytes)} limit.`,
    );
  }

  if (!res.body) {
    throw new Error("download response has no body");
  }

  await ensureDir(path.dirname(destinationFile));
  const tmp = `${destinationFile}.tmp-${process.pid}-${Date.now()}`;
  let written = 0;
  const file = await fs.open(tmp, "w");
  try {
    for await (const chunk of Readable.fromWeb(res.body as never)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
      written += buf.length;
      if (written > maxBytes) {
        throw new AttachmentRejectedError(
          `attachment exceeds ${formatBytes(maxBytes)}`,
          `Downloaded file exceeded the ${formatBytes(maxBytes)} limit.`,
        );
      }
      await file.write(buf);
    }
    await file.close();
    await fs.rename(tmp, destinationFile);
    return written;
  } catch (error) {
    await file.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

export function ensureSessionScopedPath(file: string | undefined, destinationDir: string): void {
  if (!file) return;
  const relative = path.relative(path.resolve(destinationDir), path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`attachment stored outside session attachments directory: ${file}`);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}
