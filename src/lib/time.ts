export function isoTimestamp(date = new Date()): string {
  return date.toISOString();
}

export function fsTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_");
}

// ─── Timezone-aware calendar keys (for usage windowing/partitioning) ────────

/**
 * Calendar date ("YYYY-MM-DD") of an instant in the given IANA timezone.
 * `en-CA` locale formats as YYYY-MM-DD, so the result sorts lexically by date.
 * Falls back to UTC when `tz` is not a recognized zone.
 */
export function tzDateKey(input: string | Date, tz: string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function utcKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Date key of the ISO-week Monday (week start) containing `now`, in `tz`. */
export function weekStartKey(now: Date, tz: string): string {
  const [y, m, d] = tzDateKey(now, tz).split("-").map(Number);
  // Noon UTC of the local calendar date — avoids DST edge cases; we only use Y/M/D.
  const anchor = new Date(Date.UTC(y!, m! - 1, d!, 12));
  const isoDow = anchor.getUTCDay() === 0 ? 7 : anchor.getUTCDay(); // 1=Mon..7=Sun
  anchor.setUTCDate(anchor.getUTCDate() - (isoDow - 1));
  return utcKey(anchor);
}

/** Date key of the first day of the month containing `now`, in `tz`. */
export function monthStartKey(now: Date, tz: string): string {
  return `${tzDateKey(now, tz).slice(0, 7)}-01`;
}

/** Inclusive list of "YYYY-MM-DD" keys from startKey to endKey (ascending). */
export function dateKeyRange(startKey: string, endKey: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const cursor = new Date(Date.UTC(sy!, sm! - 1, sd!, 12));
  let guard = 0;
  while (utcKey(cursor) <= endKey && guard < 4000) {
    out.push(utcKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard++;
  }
  return out;
}
