import type http from "node:http";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit`);
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readRequestBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<string> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    throw new RequestBodyTooLargeError(maxBytes);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      req.resume();
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
