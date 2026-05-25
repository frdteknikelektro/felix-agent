export function isoTimestamp(date = new Date()): string {
  return date.toISOString();
}

export function fsTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_");
}
