/**
 * Message dialect — the single seam that renders a harness's CommonMark reply
 * into a source's native formatting. Harnesses answer in CommonMark; each
 * source that doesn't render CommonMark natively needs its own dialect. This
 * module parses CommonMark once into a small AST, then renders per dialect, so
 * the platform formatting rules (and the tricky bold/italic disambiguation)
 * live in exactly one place instead of being copy-pasted per adapter.
 *
 * Coverage is deliberately the subset harnesses actually emit — bold, italic,
 * strikethrough, inline code, fenced code blocks, headers, bullet lists, and
 * links. Everything else (ordered lists, blockquotes, images, pipe tables)
 * passes through as literal text rather than being dropped.
 */

export type Dialect = "slack" | "whatsapp" | "telegram-html";

// ─── AST ──────────────────────────────────────────────────────────────────────

type Inline =
  | { type: "text"; value: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; children: Inline[]; url: string };

type Block =
  | { type: "codeblock"; raw: string }
  | { type: "line"; kind: "plain" | "header" | "bullet"; indent?: string; children: Inline[] };

// ─── Public seam ────────────────────────────────────────────────────────────────

export function toDialect(text: string, dialect: Dialect): string {
  // Only sources whose rendering diverges from CommonMark need a dialect.
  // Discord and Mattermost render CommonMark/GFM natively, so they never call
  // this — there is no identity dialect to carry dead weight.
  return parseBlocks(text)
    .map((block) => renderBlock(block, dialect))
    .join("\n");
}

// ─── Block parse (line-oriented) ────────────────────────────────────────────────

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — accumulate verbatim (never inline-parsed).
    const fence = line.match(/^\s*(```+)/);
    if (fence) {
      const marker = fence[1];
      const buf = [line];
      i++;
      while (i < lines.length) {
        buf.push(lines[i]);
        const closed = lines[i].trimStart().startsWith(marker);
        i++;
        if (closed) break;
      }
      blocks.push({ type: "codeblock", raw: buf.join("\n") });
      continue;
    }

    const header = line.match(/^(#{1,6})\s+(.*)$/);
    if (header) {
      blocks.push({ type: "line", kind: "header", children: parseInline(header[2]) });
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({ type: "line", kind: "bullet", indent: bullet[1], children: parseInline(bullet[2]) });
      i++;
      continue;
    }

    blocks.push({ type: "line", kind: "plain", children: parseInline(line) });
    i++;
  }

  return blocks;
}

// ─── Inline parse ───────────────────────────────────────────────────────────────

function parseInline(s: string): Inline[] {
  const nodes: Inline[] = [];
  let plain = "";
  let i = 0;

  const flush = () => {
    if (plain) {
      nodes.push({ type: "text", value: plain });
      plain = "";
    }
  };

  while (i < s.length) {
    const ch = s[i];

    // Inline code — raw, highest precedence.
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: "code", value: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Link [text](url).
    if (ch === "[") {
      const close = s.indexOf("]", i + 1);
      if (close !== -1 && s[close + 1] === "(") {
        const urlEnd = s.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          flush();
          nodes.push({
            type: "link",
            children: parseInline(s.slice(i + 1, close)),
            url: s.slice(close + 2, urlEnd),
          });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Emphasis / strikethrough delimiter runs.
    if (ch === "*" || ch === "_" || ch === "~") {
      let j = i + 1;
      while (j < s.length && s[j] === ch) j++;
      const runLen = j - i;

      // CommonMark does not emphasize underscores inside a word (snake_case).
      const prev = s[i - 1];
      const intraWordUnderscore = ch === "_" && prev !== undefined && /\w/.test(prev);

      let kind: "bold" | "italic" | "strike" | null = null;
      let markLen = 1;
      if (ch === "~") {
        if (runLen >= 2) {
          kind = "strike";
          markLen = 2;
        }
      } else if (!intraWordUnderscore) {
        kind = runLen >= 2 ? "bold" : "italic";
        markLen = runLen >= 2 ? 2 : 1;
      }

      if (kind) {
        const marker = ch.repeat(markLen);
        const innerStart = i + markLen;
        const closeIdx = findClosing(s, marker, ch, innerStart);
        if (closeIdx !== -1) {
          flush();
          nodes.push({ type: kind, children: parseInline(s.slice(innerStart, closeIdx)) });
          i = closeIdx + markLen;
          continue;
        }
      }

      plain += ch;
      i++;
      continue;
    }

    plain += ch;
    i++;
  }

  flush();
  return nodes;
}

/**
 * Find the closing delimiter for an emphasis/strike run: the next occurrence of
 * `marker` whose run length matches (not part of a longer run) and — for
 * underscore — is not word-internal on the closing side.
 */
function findClosing(s: string, marker: string, ch: string, from: number): number {
  const len = marker.length;
  let k = from;
  while (k < s.length) {
    const idx = s.indexOf(marker, k);
    if (idx === -1) return -1;
    const runExact = (len === 1 ? s[idx - 1] !== ch : true) && s[idx + len] !== ch;
    const after = s[idx + len];
    const underscoreOk = ch === "_" ? !(after !== undefined && /\w/.test(after)) : true;
    if (runExact && underscoreOk) return idx;
    k = idx + len;
  }
  return -1;
}

// ─── Render ─────────────────────────────────────────────────────────────────────

function renderBlock(block: Block, dialect: Dialect): string {
  if (block.type === "codeblock") return renderCodeblock(block.raw, dialect);
  const inner = block.children.map((n) => renderInline(n, dialect)).join("");
  if (block.kind === "header") {
    return dialect === "telegram-html" ? `<b>${inner}</b>` : `*${inner}*`;
  }
  if (block.kind === "bullet") return `${block.indent ?? ""}• ${inner}`;
  return inner;
}

function renderCodeblock(raw: string, dialect: Dialect): string {
  if (dialect === "telegram-html") {
    const lines = raw.split("\n");
    if (lines.length) lines.shift(); // opening fence
    if (lines.length && /^\s*```+/.test(lines[lines.length - 1])) lines.pop(); // closing fence
    return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
  }
  // Slack and WhatsApp both fence with triple backticks — pass through verbatim.
  return raw;
}

function renderInline(node: Inline, dialect: Dialect): string {
  const wrap = (children: Inline[]) => children.map((n) => renderInline(n, dialect)).join("");
  switch (node.type) {
    case "text":
      return dialect === "telegram-html" ? escapeHtml(node.value) : node.value;
    case "bold":
      return dialect === "telegram-html" ? `<b>${wrap(node.children)}</b>` : `*${wrap(node.children)}*`;
    case "italic":
      return dialect === "telegram-html" ? `<i>${wrap(node.children)}</i>` : `_${wrap(node.children)}_`;
    case "strike":
      return dialect === "telegram-html" ? `<s>${wrap(node.children)}</s>` : `~${wrap(node.children)}~`;
    case "code":
      return dialect === "telegram-html" ? `<code>${escapeHtml(node.value)}</code>` : `\`${node.value}\``;
    case "link":
      return renderLink(node, dialect, wrap);
  }
}

function renderLink(
  node: Extract<Inline, { type: "link" }>,
  dialect: Dialect,
  wrap: (children: Inline[]) => string,
): string {
  const label = plainText(node.children);
  switch (dialect) {
    case "slack":
      return `<${node.url}|${label}>`;
    case "telegram-html":
      return `<a href="${escapeHtml(node.url)}">${wrap(node.children)}</a>`;
    case "whatsapp":
      // WhatsApp has no masked-link syntax; keep both label and destination,
      // collapsing to a bare URL when the label adds nothing.
      return !label || label === node.url ? node.url : `${label} (${node.url})`;
    default:
      return node.url;
  }
}

function plainText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.type === "text" || n.type === "code" ? n.value : plainText(n.children)))
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
