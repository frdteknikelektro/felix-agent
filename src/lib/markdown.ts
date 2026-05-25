import YAML from "yaml";

export function parseFrontmatter<T extends object = Record<string, unknown>>(input: string): {
  frontmatter: T;
  body: string;
} {
  const raw = input ?? "";
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {} as T, body: raw };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) {
    return { frontmatter: {} as T, body: raw };
  }
  const frontmatterRaw = raw.slice(4, end);
  const body = raw.slice(end + 5);
  try {
    return {
      frontmatter: (YAML.parse(frontmatterRaw) ?? {}) as T,
      body,
    };
  } catch {
    return { frontmatter: {} as T, body: raw };
  }
}

export function renderFrontmatter(frontmatter: object, body: string): string {
  const yaml = YAML.stringify(frontmatter).trimEnd();
  const bodyText = body.startsWith("\n") ? body : `\n${body}`;
  return `---\n${yaml}\n---${bodyText}`;
}

export function mdList(items: string[]): string {
  if (items.length === 0) return "(none)";
  return items.map((item) => `- ${item}`).join("\n");
}
