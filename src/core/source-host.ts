import type { UniversalAttachment } from "../types.js";
import { AttachmentRejectedError, formatBytes } from "./attachments.js";

// ─── Source host ────────────────────────────────────────────────────────────
//
// The source-neutral shell that runs a Source driver. It owns the three things
// every source adapter otherwise hand-rolls identically:
//
//   1. Lifecycle      — run(driver) → {stop, done}, the disabled no-op guard,
//                       and idempotent stop wiring.
//   2. Dedup          — a bounded seen-cache keyed by raw platform message id,
//                       swept on insert so it never grows without bound. This is
//                       the layer that catches platform redelivery *before*
//                       persistence; the engine's hasThreadEvent is the durable
//                       second layer.
//   3. Attachment gate — gateAttachment() throws the shared AttachmentRejectedError
//                       when an attachment is over the limit.
//
// The driver supplies only what differs per platform (connect/parse/post/react).

/** Window after which a remembered message id is treated as unseen again. */
export const DEFAULT_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;

/** A live platform connection a driver hands back from connect(). */
export interface SourceConnection {
  /** Tear down the platform listener. Called once on stop(). */
  disconnect(): void | Promise<void>;
  /** Resolves if the source ends on its own (not via stop()). Optional. */
  closed?: Promise<void>;
}

/** The platform-specific half a Source host runs. */
export interface SourceDriver {
  source: string;
  /** When true, run() returns an inert {stop, done} without calling connect(). */
  disabled?: boolean;
  connect(): Promise<SourceConnection>;
}

export interface SourceHandle {
  stop(): void;
  done: Promise<void>;
}

export interface SourceHost {
  /** Run a driver: connect (unless disabled) and return the supervisor handle. */
  run(driver: SourceDriver): Promise<SourceHandle>;
  /**
   * Record a platform message id and report whether it is the first sighting
   * inside the TTL window. Returns false for a redelivery (caller should skip).
   * Sweeps expired entries on each call so the cache stays bounded.
   */
  firstSight(id: string): boolean;
  /** Throw AttachmentRejectedError when the attachment exceeds maxBytes. */
  gateAttachment(attachment: UniversalAttachment, maxBytes: number): void;
}

export interface SourceHostOptions {
  source: string;
  /** Dedup window; defaults to DEFAULT_DEDUP_TTL_MS. */
  ttlMs?: number;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
}

export function createSourceHost(options: SourceHostOptions): SourceHost {
  const ttlMs = options.ttlMs ?? DEFAULT_DEDUP_TTL_MS;
  const now = options.now ?? Date.now;
  const seen = new Map<string, number>();

  function sweep(currentMs: number): void {
    for (const [id, at] of seen) {
      if (currentMs - at >= ttlMs) seen.delete(id);
    }
  }

  return {
    async run(driver: SourceDriver): Promise<SourceHandle> {
      if (driver.disabled) {
        return { stop: () => undefined, done: Promise.resolve() };
      }

      const connection = await driver.connect();

      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      if (connection.closed) {
        void connection.closed.then(resolveDone, resolveDone);
      }

      let stopped = false;
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          void Promise.resolve()
            .then(() => connection.disconnect())
            .then(resolveDone, resolveDone);
        },
        done,
      };
    },

    firstSight(id: string): boolean {
      const currentMs = now();
      sweep(currentMs);
      const at = seen.get(id);
      if (at !== undefined && currentMs - at < ttlMs) return false;
      seen.set(id, currentMs);
      return true;
    },

    gateAttachment(attachment: UniversalAttachment, maxBytes: number): void {
      if (typeof attachment.size_bytes === "number" && attachment.size_bytes > maxBytes) {
        throw new AttachmentRejectedError(
          `attachment exceeds ${formatBytes(maxBytes)}`,
          `File is ${formatBytes(attachment.size_bytes)}, above the ${formatBytes(maxBytes)} limit.`,
        );
      }
    },
  };
}
