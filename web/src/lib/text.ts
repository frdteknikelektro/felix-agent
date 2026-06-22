/** Split a textarea value into a trimmed, de-duplicated list (one item per line). */
export function linesToList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  );
}

/** Render a list back into newline-separated textarea text. */
export function listToText(list: string[] | undefined): string {
  return (list ?? []).join("\n");
}
