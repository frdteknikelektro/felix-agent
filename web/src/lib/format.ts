/** Human-friendly relative time, e.g. "3m ago", "just now". */
export function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Local clock time, e.g. "14:03". */
export function clockTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Full local timestamp for tooltips. */
export function fullTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

const SOURCE_LABELS: Record<string, string> = {
  mattermost: "Mattermost",
  discord: "Discord",
  slack: "Slack",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** Thousands-separated integer, e.g. 1234567 → "1,234,567". */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

const COMPACT_FORMAT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Compact token count for tight spaces, e.g. 1234567 → "1.2M", 999999 → "1M". */
export function compactNumber(n: number): string {
  return COMPACT_FORMAT.format(Math.round(n));
}

/** Human-friendly elapsed duration for live progress. */
export function formatElapsed(elapsedMs?: number): string {
  if (elapsedMs === undefined) return "—";
  return `${Math.max(0, Math.round(elapsedMs / 1000))}s`;
}

/** A readable name for a thread: the channel/conversation part of the key. */
export function threadLabel(threadKey: string): string {
  const parts = threadKey.split(":");
  if (parts.length <= 1) return threadKey;
  return parts.slice(1).join(":");
}
