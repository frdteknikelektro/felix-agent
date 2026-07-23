#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import os from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  input as rawInput,
  select as rawSelect,
  checkbox as rawCheckbox,
  confirm as rawConfirm,
} from "@inquirer/prompts";
import {
  displayEnvValue,
  maskSecretInput,
  parseSetupTemplate,
  withoutLegacyOwnerPresentation,
  writeFileAtomic,
  writeSetupEnv,
} from "./setup-support.mjs";
import { resolveSetupOwner } from "./setup-owner-discovery.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_CONTAINER = existsSync("/app");

const ROOT = IN_CONTAINER ? "/app" : join(__dirname, "..");
const EXAMPLE_PATH = IN_CONTAINER ? "/app/.env.example" : join(ROOT, ".env.example");
const ENV_PATH = process.env.FELIX_SETUP_ENV_FILE || (IN_CONTAINER ? "/config/.env" : join(ROOT, ".env"));
const WORKSPACE_PATH = IN_CONTAINER ? "/home/node" : join(ROOT, "workspace");

// ── ANSI colors ────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  orange: "\x1b[38;5;208m",
};

// OSC 8 terminal hyperlink. The visible text stays the plain URL, so a
// terminal that doesn't support it (ignoring the unknown escape sequence)
// still shows exactly what it does today — this is purely additive.
const link = (url) => `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;

// Strip CSI escape sequences (colors, cursor moves) so a value extracted from a
// TUI's raw output isn't polluted by an adjacent reset code. A trailing
// `\x1b[0m` abutting a matched token would otherwise be swallowed by `\S+`.
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// ── Prompts ────────────────────────────────────────────────────────────────

// inquirer's default prefix is a bare "?", which reads as unexplained noise.
// Swap it for an arrow (matches the "›" used elsewhere in this wizard's output)
// so every question is self-evidently a question without a legend to explain it.
const PROMPT_THEME = {
  prefix: {
    idle: `${c.cyan}${c.bold}›${c.reset}`,
    done: `${c.green}${c.bold}✓${c.reset}`,
  },
};
const withTheme = (opts) => ({ ...opts, theme: { ...PROMPT_THEME, ...opts.theme } });
const input = (opts) => rawInput(withTheme(opts));
const select = (opts) => rawSelect(withTheme(opts));
const checkbox = (opts) => rawCheckbox(withTheme(opts));
const confirm = (opts) => rawConfirm(withTheme(opts));

// ── Logo ───────────────────────────────────────────────────────────────────

// 5×7 block glyphs, just enough letters to spell FELIX. Each "on" pixel is
// rendered as a 2×2 block below, so the logo reads big and bold in a terminal.
const LOGO_FONT = {
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
};

// Boolean pixel grid for `text`, each font pixel expanded to a `scale`×`scale` block.
function buildLogoGrid(text, { gap = 1, scale = 2 } = {}) {
  const grid = Array.from({ length: 7 * scale }, () => []);
  for (const ch of text) {
    const glyph = LOGO_FONT[ch];
    for (let gr = 0; gr < 7; gr++) {
      for (let gc = 0; gc < 5; gc++) {
        const on = glyph[gr][gc] === "1";
        for (let sr = 0; sr < scale; sr++) {
          for (let sc = 0; sc < scale; sc++) grid[gr * scale + sr].push(on);
        }
      }
    }
    for (let r = 0; r < grid.length; r++) {
      for (let g = 0; g < gap * scale; g++) grid[r].push(false);
    }
  }
  return grid;
}

// Orange → gold, true 24-bit RGB (interpolated per column, not a fixed 256-color ramp).
const LOGO_GRADIENT = [
  [255, 140, 0],
  [255, 209, 102],
];
const lerpRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgbFg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;

// COLORFGBG is set by many terminals as "fg;bg" color indices; treat a high bg
// index as a light background so the shadow blends toward white instead of black.
function terminalHasLightBackground() {
  const value = process.env.COLORFGBG;
  if (!value) return false;
  const bg = Number(value.split(";").pop());
  return Number.isInteger(bg) && bg >= 7;
}

// state: 0 = background, 1 = shadow, 2 = fill. Resolves to an RGB triple or
// null (background) for the given column, blending the shadow toward the
// terminal background instead of a fixed dark color.
function logoPixelColor(state, col, width, bgTarget) {
  if (state === 0) return null;
  const fill = lerpRgb(LOGO_GRADIENT[0], LOGO_GRADIENT[1], col / width);
  return state === 2 ? fill : lerpRgb(fill, bgTarget, 0.55);
}

// Renders the grid with a drop shadow (copy offset down-right, blended toward
// the terminal background) under the gradient fill, then packs every two
// pixel-rows into one terminal line via ▀/▄ half-blocks — halves the printed
// height instead of one pixel-row per line.
function renderLogo(text, shadowOffset = 1) {
  const grid = buildLogoGrid(text);
  const rows = grid.length;
  const cols = grid[0].length;
  const canvas = Array.from({ length: rows + shadowOffset }, () => new Array(cols + shadowOffset).fill(0));

  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      if (grid[r][cc]) canvas[r + shadowOffset][cc + shadowOffset] ||= 1; // shadow layer
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      if (grid[r][cc]) canvas[r][cc] = 2; // fill layer, drawn on top
    }
  }

  const width = canvas[0].length;
  const bgTarget = terminalHasLightBackground() ? [255, 255, 255] : [0, 0, 0];
  const lines = [];
  for (let r = 0; r < canvas.length; r += 2) {
    const top = canvas[r];
    const bottom = canvas[r + 1] || new Array(width).fill(0);
    let out = "";
    for (let i = 0; i < width; i++) {
      const topColor = logoPixelColor(top[i], i, width, bgTarget);
      const bottomColor = logoPixelColor(bottom[i], i, width, bgTarget);
      const bold = top[i] === 2 || bottom[i] === 2 ? c.bold : "";
      if (topColor && bottomColor) {
        out += `${bold}${rgbFg(topColor)}\x1b[48;2;${bottomColor[0]};${bottomColor[1]};${bottomColor[2]}m▀`;
      } else if (topColor) {
        out += `${bold}${rgbFg(topColor)}▀`;
      } else if (bottomColor) {
        out += `${bold}${rgbFg(bottomColor)}▄`;
      } else {
        out += " ";
      }
      out += c.reset;
    }
    lines.push(out);
  }
  return lines;
}

function printLogo() {
  console.log();
  console.log(renderLogo("FELIX").join("\n"));
  console.log();
  console.log(`  Configure your environment interactively.`);
  console.log(`  Press ${c.bold}Ctrl+C${c.reset} to cancel at any time.`);
  console.log();
}

function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function step(n, total, label) {
  console.log(`\n${c.cyan}${c.bold}▌${c.reset} ${c.bold}Step ${n}/${total}${c.reset} ${c.dim}·${c.reset} ${c.yellow}${label}${c.reset}`);
}

function section(label) {
  console.log(`\n${c.bold}${c.cyan}──${c.reset} ${c.bold}${label}${c.reset}\n`);
}

function succeed(msg) {
  console.log(`${c.green}${c.bold}✓${c.reset}  ${msg}`);
}

function warn(msg) {
  console.log(`${c.yellow}${c.bold}⚠${c.reset}  ${msg}`);
}

function info(msg) {
  console.log(`  ${msg}`);
}

function reqTag(required) {
  return required
    ? `${c.red}[required]${c.reset}`
    : `${c.dim}[optional]${c.reset}`;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_DEFS = {
  telegram: {
    label: "Telegram",
    required: ["TELEGRAM_BOT_TOKEN"],
    optional: {},
    ownerKeys: ["TELEGRAM_OWNER_USER_ID"],
    ownerHint: "Felix securely discovers the owner from a one-time private claim message.",
  },
  whatsapp: {
    label: "WhatsApp",
    required: [],
    optional: {},
    ownerKeys: ["WHATSAPP_OWNER_JID"],
    ownerHint: "Enter your WhatsApp phone number with country code. Felix derives the JID automatically.",
  },
  slack: {
    label: "Slack",
    required: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    optional: {},
    ownerKeys: ["SLACK_OWNER_USER_ID"],
    ownerHint: "Felix securely discovers the owner from a one-time direct message.",
  },
  discord: {
    label: "Discord",
    required: ["DISCORD_BOT_TOKEN"],
    optional: {},
    ownerKeys: ["DISCORD_OWNER_USER_ID"],
    ownerHint: "Felix securely discovers the owner from a one-time direct message.",
  },
  mattermost: {
    label: "Mattermost",
    required: ["MATTERMOST_URL", "MATTERMOST_BOT_TOKEN"],
    optional: {},
    ownerKeys: ["MATTERMOST_OWNER_USER_ID"],
    ownerHint: "Enter your Mattermost username with or without @. Felix stores only the resolved user ID.",
  },
};

// Where each channel's required token/URL comes from — shown before its prompt.
const CHANNEL_TOKEN_HINTS = {
  MATTERMOST_URL: "Your Mattermost server's base URL, e.g. https://mattermost.example.com.",
  MATTERMOST_BOT_TOKEN: `Personal access token for a bot account (System Console → Integrations → Bot Accounts). ${c.dim}${link("https://developers.mattermost.com/integrate/reference/bot-accounts/")}${c.reset}`,
  DISCORD_BOT_TOKEN: `From the Discord Developer Portal → your application → Bot → Reset Token. ${c.dim}${link("https://discord.com/developers/applications")}${c.reset}`,
  SLACK_BOT_TOKEN: `Bot token (starts with xoxb-), from OAuth & Permissions in your Slack app. ${c.dim}${link("https://api.slack.com/apps")}${c.reset}`,
  SLACK_APP_TOKEN: `App-level token (starts with xapp-), from Basic Information → App-Level Tokens. ${c.dim}${link("https://api.slack.com/apps")}${c.reset}`,
  TELEGRAM_BOT_TOKEN: `Bot token (looks like 123456789:AA...), from @BotFather — send /newbot. ${c.dim}${link("https://t.me/BotFather")}${c.reset}`,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function ensureDeps() {
  // In container: dependencies are pre-installed
  if (IN_CONTAINER) return;

  if (!existsSync(join(ROOT, "node_modules", "@inquirer"))) {
    process.stdout.write(`${c.dim}Installing dependencies...${c.reset} `);
    const code = await new Promise((resolve, reject) => {
      const child = spawn("npm", ["install"], { cwd: ROOT, stdio: "inherit" });
      child.on("exit", (code) => resolve(code ?? -1));
      child.on("error", reject);
    });
    if (code !== 0) {
      console.error(`${c.red}ERROR:${c.reset} npm install exited with code ${code}`);
      process.exit(1);
    }
  }
}

function isStrongNewSecret(value) {
  return value.length >= 24 && !["change-me", "password", "secret", "felix"].includes(value.toLowerCase());
}

function validateSetupSecret(value, existing) {
  if (existing && value === existing) return true;
  return isStrongNewSecret(value) ? true : "Use at least 24 characters (or press Enter to generate one)";
}

function existingHint(existing, key) {
  if (existing && key in existing && existing[key]) {
    return `  ${c.dim}(current: ${displayEnvValue(key, existing[key])} — Enter to keep)${c.reset}`;
  }
  return "";
}

// ── Model validation ──────────────────────────────────────────────────────

// Fetches a provider's model list and returns the set of model IDs, or null
// if the request fails (bad key, offline, endpoint down). A null result means
// "couldn't verify" — never treated as "no valid models".
async function fetchModelIds(url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const ids = (json?.data ?? []).map((m) => m?.id).filter((id) => typeof id === "string");
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Prompts for a model name, checking it against a provider's model list when
// possible. `check(value)` resolves to "valid" | "invalid" | "unknown" — only
// "invalid" interrupts the flow, since a failed/unavailable check must never
// block setup.
async function promptModelWithValidation({ message, default: def, check, providerLabel }) {
  for (;;) {
    const value = await input({ message, default: def });
    const trimmed = value.trim();
    if (!trimmed || !check) return value;
    const result = await check(trimmed);
    if (result !== "invalid") return value;
    warn(`"${trimmed}" wasn't found in ${providerLabel}'s current model list.`);
    const keep = await confirm({ message: "Use it anyway?", default: true });
    if (keep) return value;
  }
}

function ownerDiscoveryPrompts() {
  return {
    input: (options) => input(options),
    select: (options) => select(options),
    confirmExisting: ({ source }) => confirm({
      message: `Keep the existing ${SOURCE_DEFS[source].label} owner?`,
      default: true,
    }),
    showClaim: async ({ source, claimCode }) => {
      info(`Send this exact one-time message to the ${SOURCE_DEFS[source].label} bot in a private chat:`);
      // No bold/color on the code itself — a rich-text clipboard copy of a
      // styled ANSI run can get reinterpreted as markdown (e.g. **code**) by
      // a chat composer's paste handler, which breaks the exact-match check.
      console.log(`\n  ${claimCode}\n`);
      info("Waiting up to five minutes for the matching private message...");
    },
    showConfirmation: ({ source }) => {
      succeed(`${SOURCE_DEFS[source].label} account found and verified.`);
    },
  };
}

async function promptRequired(key, src, existing) {
  const hasExisting = existing && existing[key];
  const hint = hasExisting
    ? `  ${c.dim}(current: ${displayEnvValue(key, existing[key])} — Enter to keep)${c.reset}`
    : "";
  const val = await input({
    message: `${key}  ${reqTag(true)}:${hint}`,
    transformer: maskSecretInput,
    validate: (v) => {
      if (v.length > 0) return true;
      if (hasExisting) return true;
      return `${key} is required for ${src}`;
    },
  });
  return val;
}

function pad(key, width) {
  return key.length >= width ? key : key + " ".repeat(width - key.length);
}

function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    if (typeof parse === "undefined") return null;
    const obj = parse(match[1]);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

let parse; // set lazily when yaml is available

async function scanSkillEnv(dirs) {
  try {
    parse = (await import("yaml")).parse;
  } catch {
    return [];
  }

  const seen = new Set();
  const vars = [];

  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const md = join(dir, d.name, "SKILL.md");
      if (!existsSync(md)) continue;

      let raw;
      try {
        raw = readFileSync(md, "utf8");
      } catch {
        continue;
      }

      const fm = extractFrontmatter(raw);
      if (!fm || !Array.isArray(fm.env)) continue;

      for (const entry of fm.env) {
        if (!entry || !entry.key || seen.has(entry.key)) continue;
        seen.add(entry.key);
        vars.push({
          key: entry.key,
          description: entry.description || "",
          required: entry.required === true,
          secret: entry.secret === true,
          default: entry.default || "",
          skill: d.name,
        });
      }
    }
  }
  return vars;
}

function isWacliStoreLocked(text) {
  return /store (is )?locked|store locked|resource temporarily unavailable/i.test(text);
}

function checkSetupWacliAuth(bin) {
  try {
    const result = spawnSync(bin, ["doctor", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (isWacliStoreLocked(detail)) {
      return { status: "locked", detail };
    }
    if (result.status !== 0) {
      return { status: "unknown", detail };
    }

    const parsed = JSON.parse(result.stdout.trim());
    const data = parsed?.data ?? {};
    if (data.linked_jid) {
      return {
        status: "authenticated",
        jid: String(data.linked_jid),
        connected: Boolean(data.connected),
      };
    }
    return { status: "unauthenticated", detail };
  } catch (err) {
    return {
      status: "unknown",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runWacliAuth(bin) {
  const authChild = spawn(bin, ["auth"], {
    stdio: "inherit",
    env: {
      ...process.env,
    },
  });
  return await new Promise((resolve) => {
    authChild.on("error", (err) => resolve({
      exitCode: -1,
      error: err instanceof Error ? err.message : String(err),
    }));
    authChild.on("close", (code) => resolve({ exitCode: code ?? -1 }));
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function main() {
  try {
    await ensureDeps();

    if (!existsSync(EXAMPLE_PATH)) {
      console.error(`${c.red}ERROR:${c.reset} .env.example not found. Cannot generate .env template.`);
      process.exit(1);
    }

    const existing = readEnv(ENV_PATH);
    const existingExists = Object.keys(existing).length > 0;
    const wizard = {};
    const hostUid = String(process.getuid?.() ?? 1000);
    const hostGid = String(process.getgid?.() ?? 1000);

    // Keep the container aligned with the host user that owns workspace/.
    wizard.UID = existing.UID || hostUid;
    wizard.GID = existing.GID || hostGid;

    clear();
    printLogo();

    if (existingExists) {
      console.log();
      info("Existing .env found — values are pre-filled.");
      info("Press Enter to keep, type to change.");
    }

    // ═══ Step 1: Agent Identity ═════════════════════════════════════════════

    step(1, 7, "Agent Identity");

    info("Give the agent a name — used to get its attention in group chats and shown in the owner console.");
    const agentName = await input({
      message: `FELIX_NAME  ${reqTag(true)}:`,
      default: existing.FELIX_NAME || "Felix",
      validate: (v) => v.trim().length > 0 ? true : "FELIX_NAME is required",
    });
    wizard.FELIX_NAME = agentName.trim();

    // ═══ Step 2: Harness ═══════════════════════════════════════════════════

    step(2, 7, "Harness");

    info("Harness that powers the agent's reasoning and tool use.");
    const harness = await select({
      message: `HARNESS  ${reqTag(true)}:`,
      choices: [
        { value: "codex", name: "codex — Codex CLI by OpenAI", description: `${c.dim}${link("https://github.com/openai/codex")}${c.reset}` },
        { value: "claude-code", name: "claude-code — Claude Code CLI by Anthropic", description: `${c.dim}${link("https://claude.com/claude-code")}${c.reset}` },
        { value: "opencode", name: "opencode — OpenCode CLI", description: `${c.dim}${link("https://opencode.ai")}${c.reset}` },
      ],
      default: existing.HARNESS || "codex",
    });
    wizard.HARNESS = harness;

    console.log();
    info(`9router — auto-fallback across paid, cheap, and free models to cut cost. ${c.dim}${link("https://github.com/decolua/9router")}${c.reset}`);
    const ninerouterEnabled = await confirm({
      message: `NINEROUTER_ENABLED  ${reqTag(false)}:`,
      default: existing.NINEROUTER_ENABLED === "true",
    });
    wizard.NINEROUTER_ENABLED = ninerouterEnabled ? "true" : "false";

    if (ninerouterEnabled) {
      console.log();
      info("Enter the bare gateway base, e.g. https://host.example (no /v1).");
      info("Codex/Opencode append /v1; Claude Code appends /v1/messages.");
      console.log();

      const nrKey = await promptRequired("NINEROUTER_KEY", "9router", existing);
      if (nrKey) wizard.NINEROUTER_KEY = nrKey;

      const nrBaseUrl = await input({
        message: `NINEROUTER_URL  ${reqTag(true)}  (e.g. https://9router.example.com):`,
        default: existing.NINEROUTER_URL || "",
        validate: (v) => {
          if (!v.trim()) return "NINEROUTER_URL is required when 9router is enabled";
          try {
            new URL(v);
            return true;
          } catch {
            return "Enter a valid URL";
          }
        },
      });
      wizard.NINEROUTER_URL = nrBaseUrl;

      const nrModel = await input({
        message: `NINEROUTER_MODEL  ${reqTag(true)}:`,
        default: existing.NINEROUTER_MODEL || "",
        validate: (v) => v.trim().length > 0 ? true : "NINEROUTER_MODEL is required when 9router is enabled",
      });
      wizard.NINEROUTER_MODEL = nrModel;

      const nrMemModel = await input({
        message: `NINEROUTER_MODEL_FOR_MEMORIZING  ${reqTag(true)}:`,
        default: existing.NINEROUTER_MODEL_FOR_MEMORIZING || "",
        validate: (v) => v.trim().length > 0
          ? true
          : "A dedicated low-cost Memory rollup model is required when 9router is enabled",
      });
      wizard.NINEROUTER_MODEL_FOR_MEMORIZING = nrMemModel;
    } else {
      if (existing.NINEROUTER_KEY) wizard.NINEROUTER_KEY = existing.NINEROUTER_KEY;
      if (existing.NINEROUTER_URL) wizard.NINEROUTER_URL = existing.NINEROUTER_URL;
      if (existing.NINEROUTER_MODEL) wizard.NINEROUTER_MODEL = existing.NINEROUTER_MODEL;
      if (existing.NINEROUTER_MODEL_FOR_MEMORIZING) wizard.NINEROUTER_MODEL_FOR_MEMORIZING = existing.NINEROUTER_MODEL_FOR_MEMORIZING;
    }

    // ═══ Step 3: Model & API Keys ═══════════════════════════════════════════

    step(3, 7, "Model & API Keys");

    if (harness === "codex") {
      // Model validation needs a plain bearer key, so auth/key comes first.
      // OAuth (ChatGPT Plus session) has no such key — validation is skipped then.
      let codexApiKey = null;

      if (ninerouterEnabled) {
        info("9router is enabled, so Codex will use NINEROUTER_KEY at runtime.");
        console.log();
        info("Optional fallback OPENAI_API_KEY, only used if 9router is later disabled.");
        const oaiKey = await input({
          message: `OPENAI_API_KEY  ${reqTag(false)}:${existingHint(existing, "OPENAI_API_KEY") || `  ${c.dim}(Enter to skip)${c.reset}`}`,
          transformer: maskSecretInput,
        });
        if (oaiKey) wizard.OPENAI_API_KEY = oaiKey;
        codexApiKey = oaiKey || existing.OPENAI_API_KEY || null;
      } else {
        info("How Codex authenticates: a raw API key, or OAuth login with your ChatGPT Plus account.");
        const authMethod = await select({
          message: `Codex authentication method  ${reqTag(true)}:`,
          choices: [
            { value: "api-key", name: "api-key — Use OpenAI API key" },
            { value: "oauth", name: "oauth — Login with ChatGPT Plus account (device auth)" },
          ],
          default: existing.OPENAI_CODEX_AUTH_JSON ? "oauth" : "api-key",
        });

        if (authMethod === "api-key") {
          console.log();
          info(`Get a key at ${c.dim}${link("https://platform.openai.com/api-keys")}${c.reset}`);
          const oaiKey = await promptRequired("OPENAI_API_KEY", "codex", existing);
          if (oaiKey) wizard.OPENAI_API_KEY = oaiKey;
          codexApiKey = oaiKey || existing.OPENAI_API_KEY || null;
        } else {
          // OAuth: use a temp home under workspace
          const tmpHome = join(WORKSPACE_PATH, `.felix-oauth-${randomUUID().slice(0, 8)}`);
          mkdirSync(tmpHome, { recursive: true });

          console.log();
          info("Launching device auth...");
          info("A browser window will open. Enter the code shown below.");
          // No console.log() here — codex's own CLI output already opens
          // with a blank line; stacking ours on top doubles the gap.

          const child = spawn("codex", ["login", "--device-auth"], {
            env: { ...process.env, CODEX_HOME: tmpHome },
            stdio: "inherit",
          });
          const exitCode = await new Promise((resolve) => {
            child.on("close", (code) => resolve(code ?? -1));
          });
          console.log();

          if (exitCode !== 0) {
            warn("codex login failed. Falling back to API key method.");
            wizard.OPENAI_CODEX_AUTH_JSON = "";
            info(`Get a key at ${c.dim}${link("https://platform.openai.com/api-keys")}${c.reset}`);
            const oaiKey = await promptRequired("OPENAI_API_KEY", "codex", existing);
            if (oaiKey) wizard.OPENAI_API_KEY = oaiKey;
            codexApiKey = oaiKey || existing.OPENAI_API_KEY || null;
          } else {
            const authPath = join(tmpHome, "auth.json");
            const authContent = readFileSync(authPath, "utf8");
            wizard.OPENAI_CODEX_AUTH_JSON = JSON.stringify(JSON.parse(authContent));
            wizard.OPENAI_API_KEY = "";
            succeed("Logged in via ChatGPT OAuth");
            // codexApiKey stays null — a ChatGPT session isn't a bearer key
            // the public /v1/models endpoint will accept.
          }

          // Clean up temp dir
          try { rmSync(tmpHome, { recursive: true }); } catch {}
        }
      }

      console.log();
      const codexModelIds = codexApiKey
        ? await fetchModelIds("https://api.openai.com/v1/models", { Authorization: `Bearer ${codexApiKey}` })
        : null;
      if (codexApiKey && !codexModelIds) {
        info("Couldn't reach OpenAI to verify model names — skipping that check.");
      }
      const checkCodexModel = codexModelIds ? (v) => (codexModelIds.has(v) ? "valid" : "invalid") : null;

      info("Codex model used for normal turns.");
      const codexModel = await promptModelWithValidation({
        message: `CODEX_MODEL  ${reqTag(false)}:`,
        default: existing.CODEX_MODEL || "gpt-5.6-luna",
        check: checkCodexModel,
        providerLabel: "OpenAI",
      });
      wizard.CODEX_MODEL = codexModel;

      console.log();
      info("Dedicated low-cost model for Memory rollups; it never falls back to CODEX_MODEL.");
      const codexMemModel = await promptModelWithValidation({
        message: `CODEX_MODEL_FOR_MEMORIZING  ${reqTag(false)}:`,
        default: existing.CODEX_MODEL_FOR_MEMORIZING || "gpt-5.4-mini",
        check: checkCodexModel,
        providerLabel: "OpenAI",
      });
      wizard.CODEX_MODEL_FOR_MEMORIZING = codexMemModel;
    }

    if (harness === "opencode") {
      info(ninerouterEnabled
        ? "API key for the OpenCode provider (unused while 9router is enabled, but kept as a fallback)."
        : "API key for the OpenCode provider.");
      const ocKey = ninerouterEnabled
        ? await input({
            message: `OPENCODE_API_KEY  ${reqTag(false)}:${existingHint(existing, "OPENCODE_API_KEY") || `  ${c.dim}(Enter to skip)${c.reset}`}`,
            transformer: maskSecretInput,
          })
        : await promptRequired("OPENCODE_API_KEY", "opencode", existing);
      if (ocKey) wizard.OPENCODE_API_KEY = ocKey;

      console.log();
      info("Optional: API key for OpenRouter, only needed if OPENCODE_MODEL points at an openrouter/... model.");
      info(`Get a key at ${c.dim}${link("https://openrouter.ai/keys")}${c.reset}`);
      const orKey = await input({
        message: `OPENROUTER_API_KEY  ${reqTag(false)}:${existingHint(existing, "OPENROUTER_API_KEY") || `  ${c.dim}(Enter to skip)${c.reset}`}`,
        transformer: maskSecretInput,
      });
      if (orKey) wizard.OPENROUTER_API_KEY = orKey;

      // opencode/... routes through OpenCode's own catalog, which has no
      // public list-models endpoint to verify against — skip validation.
      console.log();
      info("OpenCode model, as provider/model — e.g. opencode/... for opencode.ai routing.");
      const ocModel = await promptModelWithValidation({
        message: `OPENCODE_MODEL  ${reqTag(false)}:`,
        default: existing.OPENCODE_MODEL || "opencode/deepseek-v4-flash-free",
        check: null,
        providerLabel: "OpenCode",
      });
      wizard.OPENCODE_MODEL = ocModel;

      console.log();
      info("Dedicated low-cost model for Memory rollups; it never falls back to OPENCODE_MODEL.");
      const ocMemModel = await promptModelWithValidation({
        message: `OPENCODE_MODEL_FOR_MEMORIZING  ${reqTag(false)}:`,
        default: existing.OPENCODE_MODEL_FOR_MEMORIZING || "opencode/deepseek-v4-flash-free",
        check: null,
        providerLabel: "OpenCode",
      });
      wizard.OPENCODE_MODEL_FOR_MEMORIZING = ocMemModel;

      console.log();
      info("Reasoning effort for OpenCode: low, medium, or high.");
      const ocVariant = await input({
        message: `OPENCODE_VARIANT  ${reqTag(false)}:`,
        default: existing.OPENCODE_VARIANT || "high",
      });
      wizard.OPENCODE_VARIANT = ocVariant;
    }

    if (harness === "claude-code") {
      // Model validation needs a plain bearer credential, so auth/key comes first.
      let anthropicApiKey = null;
      let anthropicOAuthToken = null;

      if (ninerouterEnabled) {
        info("Optional fallback ANTHROPIC_API_KEY, only used if 9router is later disabled.");
        const ccKey = await input({
          message: `ANTHROPIC_API_KEY  ${reqTag(false)}:${existingHint(existing, "ANTHROPIC_API_KEY") || `  ${c.dim}(Enter to skip)${c.reset}`}`,
          transformer: maskSecretInput,
        });
        if (ccKey) wizard.ANTHROPIC_API_KEY = ccKey;
        anthropicApiKey = ccKey || existing.ANTHROPIC_API_KEY || null;
      } else {
        info("How Claude Code authenticates: a raw API key, or OAuth login with your Claude subscription.");
        const authMethod = await select({
          message: `Claude Code authentication method  ${reqTag(true)}:`,
          choices: [
            { value: "api-key", name: "api-key — Use Anthropic API key" },
            { value: "oauth", name: "oauth — Login with Claude subscription (Pro/Max/Team)" },
          ],
          default: existing.CLAUDE_CODE_OAUTH_TOKEN ? "oauth" : "api-key",
        });

        if (authMethod === "api-key") {
          console.log();
          info(`Get a key at ${c.dim}${link("https://console.anthropic.com/settings/keys")}${c.reset}`);
          const ccKey = await promptRequired("ANTHROPIC_API_KEY", "claude-code", existing);
          if (ccKey) wizard.ANTHROPIC_API_KEY = ccKey;
          anthropicApiKey = ccKey || existing.ANTHROPIC_API_KEY || null;
        } else {
          console.log();
          info("Launching device auth...");
          info("A browser window will open. Approve access, then return here.");

          // `claude setup-token` is an Ink TUI — with stdout piped (not a TTY)
          // it can't redraw in place, so it reprints its whole splash/spinner
          // frame on every tick. Forwarding that raw would flood the terminal.
          // Buffer silently instead, and surface only the sign-in URL — the
          // one thing the user actually needs — the first time it appears.
          // stdin stays inherited so a pasted callback code still reaches
          // `claude` directly, even though we never show its own prompt text.
          //
          // The child's own masked-input feedback lives inside that suppressed
          // frame-spam too, and there's no reliable way to tell from here
          // whether or in what form it renders — so don't try to mirror it.
          // Set the right expectation up front instead, and nudge if nothing
          // has happened in a while, so silence doesn't read as "did my
          // paste even register?"
          let output = "";
          let printedUrl = false;
          let lastActivityAt = Date.now();
          let idleNoticeShown = false;
          info("Typing or pasting the code won't show anything here — that's expected. Paste it, then press Enter.");
          const child = spawn("claude", ["setup-token"], {
            env: { ...process.env },
            stdio: ["inherit", "pipe", "inherit"],
          });
          child.stdout.on("data", (chunk) => {
            output += chunk.toString("utf8");
            lastActivityAt = Date.now();
            idleNoticeShown = false;
            if (!printedUrl) {
              const urlMatch = stripAnsi(output).match(/https:\S*oauth\/authorize\S*/);
              if (urlMatch) {
                printedUrl = true;
                info("If the browser didn't open, visit this URL to sign in:");
                console.log(`\n  ${c.bold}${c.yellow}${urlMatch[0]}${c.reset}\n`);
                info("If it asks you to paste a code back, type it here and press Enter.");
              }
            }
          });
          const idleReminder = setInterval(() => {
            if (printedUrl && !idleNoticeShown && Date.now() - lastActivityAt > 20_000) {
              idleNoticeShown = true;
              info("Still here — paste the code (nothing will show) and press Enter.");
            }
          }, 5_000);
          const exitCode = await new Promise((resolve) => {
            // Containers commonly can't reach the local OAuth callback server
            // (Anthropic's own docs flag this), falling back to a manual
            // paste-code prompt — without a timeout a stalled flow would hang
            // the wizard forever with only Ctrl+C as an escape.
            const timeout = setTimeout(() => {
              child.kill();
              resolve(-1);
            }, 5 * 60 * 1000);
            child.on("close", (code) => {
              clearTimeout(timeout);
              resolve(code ?? -1);
            });
          });
          clearInterval(idleReminder);
          console.log();

          // \S+ rather than a fixed charset — the exact token alphabet isn't
          // authoritatively documented, and a too-narrow charset would
          // silently truncate a valid token instead of failing loudly.
          const tokenMatch = stripAnsi(output).match(/sk-ant-oat01-\S+/);
          if (exitCode !== 0 || !tokenMatch) {
            warn("claude setup-token failed. Falling back to API key method.");
            wizard.CLAUDE_CODE_OAUTH_TOKEN = "";
            info(`Get a key at ${c.dim}${link("https://console.anthropic.com/settings/keys")}${c.reset}`);
            const ccKey = await promptRequired("ANTHROPIC_API_KEY", "claude-code", existing);
            if (ccKey) wizard.ANTHROPIC_API_KEY = ccKey;
            anthropicApiKey = ccKey || existing.ANTHROPIC_API_KEY || null;
          } else {
            wizard.CLAUDE_CODE_OAUTH_TOKEN = tokenMatch[0];
            // Claude Code's own auth precedence ranks ANTHROPIC_API_KEY above
            // CLAUDE_CODE_OAUTH_TOKEN — clear it so the OAuth token actually wins.
            wizard.ANTHROPIC_API_KEY = "";
            succeed("Logged in via Claude subscription");
            anthropicOAuthToken = tokenMatch[0];
          }
        }
      }

      // Claude Code accepts these short aliases directly — they never appear
      // in /v1/models (which lists full model IDs), so treat them as valid
      // without a network round-trip.
      const CLAUDE_CODE_CHOICES = [
        { value: "sonnet", name: "sonnet — balanced default, best for most tasks" },
        { value: "opus", name: "opus — most capable, higher cost & latency" },
        { value: "haiku", name: "haiku — fastest and cheapest" },
        { value: "fable", name: "fable — alternate Claude model" },
      ];
      const CLAUDE_CODE_ALIASES = new Set(CLAUDE_CODE_CHOICES.map((choice) => choice.value));
      const CLAUDE_CODE_CUSTOM = "__custom__";

      async function pickClaudeModel({ envKey, defaultValue, check }) {
        const isKnownAlias = CLAUDE_CODE_ALIASES.has(defaultValue);
        const picked = await select({
          message: `${envKey}  ${reqTag(false)}:`,
          choices: [...CLAUDE_CODE_CHOICES, { value: CLAUDE_CODE_CUSTOM, name: "other — enter a full model ID" }],
          default: isKnownAlias ? defaultValue : CLAUDE_CODE_CUSTOM,
        });
        if (picked !== CLAUDE_CODE_CUSTOM) return picked;
        return promptModelWithValidation({
          message: `${envKey} (custom)  ${reqTag(false)}:`,
          default: isKnownAlias ? "" : defaultValue,
          check,
          providerLabel: "Anthropic",
        });
      }

      console.log();
      // OAuth tokens authenticate differently from API keys — Bearer, not
      // x-api-key, plus the oauth beta header (x-api-key returns 401).
      const anthropicModelIds = anthropicApiKey
        ? await fetchModelIds("https://api.anthropic.com/v1/models", {
            "x-api-key": anthropicApiKey,
            "anthropic-version": "2023-06-01",
          })
        : anthropicOAuthToken
          ? await fetchModelIds("https://api.anthropic.com/v1/models", {
              Authorization: `Bearer ${anthropicOAuthToken}`,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "oauth-2025-04-20",
            })
          : null;
      if ((anthropicApiKey || anthropicOAuthToken) && !anthropicModelIds) {
        info("Couldn't reach Anthropic to verify model names — skipping that check.");
      }
      const checkClaudeModel = anthropicModelIds
        ? (v) => (CLAUDE_CODE_ALIASES.has(v) || anthropicModelIds.has(v) ? "valid" : "invalid")
        : null;

      info("Claude Code model used for normal turns.");
      const ccModel = await pickClaudeModel({
        envKey: "CLAUDE_CODE_MODEL",
        defaultValue: existing.CLAUDE_CODE_MODEL || "sonnet",
        check: checkClaudeModel,
      });
      wizard.CLAUDE_CODE_MODEL = ccModel;

      console.log();
      info("Dedicated low-cost model for Memory rollups; it never falls back to CLAUDE_CODE_MODEL.");
      const ccMemModel = await pickClaudeModel({
        envKey: "CLAUDE_CODE_MODEL_FOR_MEMORIZING",
        defaultValue: existing.CLAUDE_CODE_MODEL_FOR_MEMORIZING || "haiku",
        check: checkClaudeModel,
      });
      wizard.CLAUDE_CODE_MODEL_FOR_MEMORIZING = ccMemModel;
    }

    // ═══ Step 4: Owner Console ══════════════════════════════════════════════

    step(4, 7, "Owner Console");

    info("Enter a secret for the owner web console.");

    const secret = await input({
      message: `OWNER_UI_SECRET  ${reqTag(false)}:`,
      default: existing.OWNER_UI_SECRET || randomUUID(),
      transformer: maskSecretInput,
      validate: (value) => validateSetupSecret(value, existing.OWNER_UI_SECRET),
    });
    if (existing.OWNER_UI_SECRET && !isStrongNewSecret(existing.OWNER_UI_SECRET)) {
      warn("SECURITY WARNING: existing OWNER_UI_SECRET is weaker than the 24-character policy; preserving it only for upgrade compatibility. Rotate it promptly.");
    }
    wizard.OWNER_UI_SECRET = secret;

    // Database encryption key — no need to interrupt setup for this; generate
    // silently and let the user rotate it later in .env if they ever need to.
    wizard.DB_ENCRYPTION_KEY = existing.DB_ENCRYPTION_KEY || randomBytes(32).toString("base64");

    // ═══ Step 5: Sources ════════════════════════════════════════════════════

    step(5, 7, "Sources");

    info("Chat sources Felix will listen to.");
    const listenSources = await checkbox({
      message: "Listening sources:",
      choices: [
        { value: "telegram", name: "Telegram", checked: !!existing.TELEGRAM_BOT_TOKEN },
        {
          value: "whatsapp",
          name: "WhatsApp",
          checked: !!(existing.WHATSAPP_OWNER_JID || existing.WHATSAPP_BOT_ALIASES || existing.WHATSAPP_BOT_NAME),
        },
        { value: "slack", name: "Slack", checked: !!(existing.SLACK_BOT_TOKEN || existing.SLACK_TOKEN) },
        { value: "discord", name: "Discord", checked: !!(existing.DISCORD_BOT_TOKEN || existing.DISCORD_TOKEN) },
        { value: "mattermost", name: "Mattermost", checked: !!(existing.MATTERMOST_BOT_TOKEN || existing.MATTERMOST_TOKEN) },
      ],
    });

    if (listenSources.length > 1) {
      console.log();
      info("Send every owner approval request to one channel, instead of wherever it originated.");
      const notifyChannel = await select({
        message: `OWNER_CHANNEL  ${reqTag(false)}:`,
        choices: [
          { value: "", name: "Same as event source (each event notifies its own source)" },
          ...listenSources.map((s) => ({ value: s, name: SOURCE_DEFS[s].label })),
        ],
        default: listenSources.includes(existing.OWNER_CHANNEL) ? existing.OWNER_CHANNEL : "",
      });
      wizard.OWNER_CHANNEL = notifyChannel;
    } else {
      wizard.OWNER_CHANNEL = "";
    }

    // ── Clear deselected sources ───────────────────────────────────────────

    for (const src of Object.keys(SOURCE_DEFS)) {
      if (!listenSources.includes(src)) {
        const def = SOURCE_DEFS[src];
        for (const key of [...def.required, ...Object.keys(def.optional), ...def.ownerKeys]) {
          wizard[key] = "";
        }
        if (src === "telegram") {
          for (const key of ["TELEGRAM_MODE", "TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET"]) wizard[key] = "";
        }
      }
    }

    // ── Cascading prompts per source ───────────────────────────────────────

    for (const src of listenSources) {
      const def = SOURCE_DEFS[src];
      section(def.label);

      if (src === "slack") {
        info(`Create an app at ${c.dim}${link("https://api.slack.com/apps")}${c.reset} with Socket Mode enabled.`);
        info(`${c.bold}App Home${c.reset} → Messages Tab → check "Allow users to send messages" (off by default — blocks DMs).`);
        info("Bot scopes: channels:history, groups:history, im:history, mpim:history, chat:write, reactions:write, reactions:read, files:read, files:write, users:read.");
        info("Event Subscriptions → Subscribe to bot events → message.channels, message.groups, message.im, message.mpim, reaction_added.");
        info("A scope alone isn't enough — each of those bot events must be added explicitly, or Slack never delivers it (e.g. private channels or reaction-based approvals stay silent).");
        info("App-Level Token needs the connections:write scope.");
        console.log();
      }

      for (let i = 0; i < def.required.length; i++) {
        const reqKey = def.required[i];
        if (i > 0) console.log();
        const hint = CHANNEL_TOKEN_HINTS[reqKey];
        if (hint) info(hint);
        const val = await promptRequired(reqKey, src, existing);
        if (val) wizard[reqKey] = val;
      }

      for (const [optKey, fallback] of Object.entries(def.optional)) {
        const val = await input({
          message: `${optKey}  ${reqTag(false)}:`,
          default: existing[optKey] || fallback || "",
        });
        wizard[optKey] = val;
      }

      if (src === "mattermost") {
        info(def.ownerHint);
        const owner = await resolveSetupOwner({
          source: "mattermost",
          credentials: {
            baseUrl: wizard.MATTERMOST_URL || existing.MATTERMOST_URL,
            botToken: wizard.MATTERMOST_BOT_TOKEN || existing.MATTERMOST_BOT_TOKEN,
          },
          existingOwnerId: existing.MATTERMOST_OWNER_USER_ID,
          prompts: ownerDiscoveryPrompts(),
        });
        wizard.MATTERMOST_OWNER_USER_ID = owner.userId;
        succeed("Mattermost owner configured.");
      } else if (src === "whatsapp") {
        info(`Optional short mention names, e.g. "f,bot" lets people write @f or @bot instead of @${wizard.FELIX_NAME}.`);
        const aliases = await input({
          message: `WHATSAPP_BOT_ALIASES  ${reqTag(false)}:`,
          default: existing.WHATSAPP_BOT_ALIASES || "",
          validate: (v) => /^[A-Za-z0-9_,]*$/.test(v) ? true : "Only letters, digits, underscores, and commas allowed",
        });
        wizard.WHATSAPP_BOT_ALIASES = aliases;

        console.log();
        info(def.ownerHint);
        const owner = await resolveSetupOwner({
          source: "whatsapp",
          credentials: {},
          existingOwnerId: existing.WHATSAPP_OWNER_JID,
          prompts: ownerDiscoveryPrompts(),
        });
        wizard.WHATSAPP_OWNER_JID = owner.userId;
        succeed("WhatsApp owner configured.");

        const wacliBin = existing.WHATSAPP_WACLI_BIN || "wacli";
        const authStatus = checkSetupWacliAuth(wacliBin);
        if (authStatus.status === "authenticated") {
          succeed("wacli is already paired.");
        } else if (authStatus.status === "locked") {
          warn("wacli store is locked, likely by the running Felix container. Skipping pairing.");
          info("Stop the container before re-pairing, or keep the existing logged-in session.");
        } else {
          console.log();
          info("Pairing wacli with WhatsApp...");
          info("A QR code will appear. Scan it with WhatsApp on your phone.");
          info("WhatsApp → Settings → Linked Devices → Link a Device");
          console.log();

          const { exitCode } = await runWacliAuth(wacliBin);
          if (exitCode !== 0) {
            warn(`wacli auth failed. Run \`${wacliBin} auth\` manually.`);
          } else {
            succeed("WhatsApp paired successfully.");
          }
        }
      } else if (src === "telegram") {
        console.log();
        info("How Felix receives Telegram messages.");
        const mode = await select({
          message: `TELEGRAM_MODE  ${reqTag(true)}:`,
          choices: [
            {
              value: "polling",
              name: "polling — no public URL required",
              description: "Felix polls Telegram's servers for updates. Simplest option, works behind NAT/firewalls.",
            },
            {
              value: "webhook",
              name: "webhook — requires HTTPS reverse proxy",
              description: "Telegram pushes updates to your own HTTPS endpoint instead. Needs a public URL with valid TLS.",
            },
          ],
          default: existing.TELEGRAM_MODE === "webhook" ? "webhook" : "polling",
        });
        wizard.TELEGRAM_MODE = mode;
        if (mode === "webhook") {
          console.log();
          info("Public HTTPS URL Telegram will push updates to (needs a reverse proxy reachable from the internet).");
          const webhookUrl = await input({
            message: `TELEGRAM_WEBHOOK_URL  ${reqTag(true)}:`,
            default: existing.TELEGRAM_WEBHOOK_URL || "",
            validate: (v) => {
              try {
                const url = new URL(v);
                return url.protocol === "https:" ? true : "Use an HTTPS URL";
              } catch {
                return "Enter a valid HTTPS URL";
              }
            },
          });
          wizard.TELEGRAM_WEBHOOK_URL = webhookUrl;

          console.log();
          info("Verifies incoming requests really come from Telegram. Auto-generated if left blank.");
          const webhookSecret = await input({
            message: `TELEGRAM_WEBHOOK_SECRET  ${reqTag(true)}:`,
            default: existing.TELEGRAM_WEBHOOK_SECRET || randomBytes(32).toString("hex"),
            transformer: maskSecretInput,
            validate: (value) => value.length >= 16 || "Use at least 16 characters",
          });
          wizard.TELEGRAM_WEBHOOK_SECRET = webhookSecret;
        } else {
          wizard.TELEGRAM_WEBHOOK_URL = "";
          wizard.TELEGRAM_WEBHOOK_SECRET = "";
        }
        console.log();
        info(def.ownerHint);
        info("First-time claims require a new or inactive bot with no registered webhook.");
        const owner = await resolveSetupOwner({
          source: "telegram",
          credentials: {
            botToken: wizard.TELEGRAM_BOT_TOKEN || existing.TELEGRAM_BOT_TOKEN,
          },
          existingOwnerId: existing.TELEGRAM_OWNER_USER_ID,
          prompts: ownerDiscoveryPrompts(),
        });
        wizard.TELEGRAM_OWNER_USER_ID = owner.userId;
        succeed("Telegram owner configured.");
      } else if (src === "discord") {
        console.log();
        info(def.ownerHint);
        info("The bot must allow Direct Messages. The claim uses only the Direct Messages intent.");
        const owner = await resolveSetupOwner({
          source: "discord",
          credentials: {
            botToken: wizard.DISCORD_BOT_TOKEN || existing.DISCORD_BOT_TOKEN,
          },
          existingOwnerId: existing.DISCORD_OWNER_USER_ID,
          prompts: ownerDiscoveryPrompts(),
        });
        wizard.DISCORD_OWNER_USER_ID = owner.userId;
        succeed("Discord owner configured.");
      } else if (src === "slack") {
        console.log();
        info(def.ownerHint);
        const owner = await resolveSetupOwner({
          source: "slack",
          credentials: {
            botToken: wizard.SLACK_BOT_TOKEN || existing.SLACK_BOT_TOKEN,
            appToken: wizard.SLACK_APP_TOKEN || existing.SLACK_APP_TOKEN,
          },
          existingOwnerId: existing.SLACK_OWNER_USER_ID,
          prompts: ownerDiscoveryPrompts(),
        });
        wizard.SLACK_OWNER_USER_ID = owner.userId;
        succeed("Slack owner configured.");
      }
    }

    // ── Telegram privacy mode reminder ───────────────────────────────────────
    if (listenSources.includes("telegram")) {
      console.log();
      warn("Telegram groups require privacy mode to be DISABLED for the bot to see mentions.");
      info("Go to @BotFather → /setprivacy → select your bot → Disable.");
    }

    if (listenSources.length === 0) {
      warn("No sources selected. You can re-run setup later.");
    }

    // ═══ Step 6: Skill Environment ══════════════════════════════════════════

    step(6, 7, "Skill Environment");

    const skillDirs = [join(ROOT, "skills")];
    const agentsDir = join(WORKSPACE_PATH, ".agents", "skills");
    if (existsSync(agentsDir)) skillDirs.push(agentsDir);

    const skillVars = await scanSkillEnv(skillDirs);
    const pendingSkillVars = skillVars.filter((v) => !(v.key in wizard));

    if (pendingSkillVars.length === 0) {
      info("No skill environment variables to configure.");
    } else {
      info("Bundled skills request these environment variables.");

      // Group by skill
      const bySkill = new Map();
      for (const v of pendingSkillVars) {
        if (!bySkill.has(v.skill)) bySkill.set(v.skill, []);
        bySkill.get(v.skill).push(v);
      }

      for (const [skill, vars] of bySkill) {
        process.stdout.write("\n");
        const setupEnv = await confirm({
          message: `Configure ${skill} environment now?`,
          default: true,
        });
        if (!setupEnv) {
          for (const v of vars) {
            if (existing && existing[v.key] && !(v.key in wizard)) {
              wizard[v.key] = existing[v.key];
            }
            if (v.key === "GOG_KEYRING_PASSWORD" && !existing?.[v.key] && !(v.key in wizard)) {
              wizard[v.key] = randomBytes(32).toString("hex");
            }
          }
          continue;
        }
        section(skill);
        for (const v of vars) {
          const hasExisting = existing && existing[v.key];
          const hint = hasExisting
            ? `  ${c.dim}(current: ${displayEnvValue(v.key, existing[v.key])} — Enter to keep)${c.reset}`
            : "";
          const val = await input({
            message: `${v.key}  ${reqTag(v.required)}:${hint}`,
            default: hasExisting
              ? existing[v.key]
              : (v.default || (v.key === "GOG_KEYRING_PASSWORD" ? randomBytes(32).toString("hex") : "")),
            transformer: v.secret ? maskSecretInput : undefined,
          });
          if (val) {
            wizard[v.key] = val;
          } else if (v.required && !hasExisting) {
            warn(`${v.key} is required by ${skill} — set it in .env later.`);
          }
        }
        console.log();
      }
    }

    // ═══ Step 7: Review ═════════════════════════════════════════════════════

    step(7, 7, "Review");

    if (wizard.NINEROUTER_ENABLED === "true") {
      console.log();
      info("9router override is enabled — it will replace the selected harness key, base URL, and model at runtime.");
    }

    const template = parseSetupTemplate(EXAMPLE_PATH);
    const templateKeys = new Set();
    const final = {};
    for (const entry of template) {
      if (entry.type !== "setting" && entry.type !== "optional") continue;
      templateKeys.add(entry.key);
      if (entry.key in wizard) {
        final[entry.key] = wizard[entry.key];
      } else if (entry.key in existing) {
        final[entry.key] = existing[entry.key];
      } else if (entry.type === "setting") {
        final[entry.key] = entry.value;
      }
    }

    // Merge skill env vars not in template
    const skillExtras = [];
    for (const [key, value] of Object.entries(wizard)) {
      if (!templateKeys.has(key)) {
        final[key] = value;
        if (value) skillExtras.push(key);
      }
    }

    const keyLens = Object.keys(final).map((k) => k.length);
    const maxKey = keyLens.length > 0 ? Math.min(32, Math.max(...keyLens) + 2) : 16;

    console.log();
    let firstSection = true;
    for (const entry of template) {
      if (entry.type === "comment" && /^# ──/.test(entry.raw)) {
        if (!firstSection) console.log();
        firstSection = false;
        console.log(`  ${c.dim}${entry.raw.slice(2)}${c.reset}`);
      } else if (entry.type === "setting" && entry.key in final) {
        const rendered = displayEnvValue(entry.key, final[entry.key]);
        const display = rendered.startsWith("<") ? c.dim + rendered + c.reset : rendered;
        console.log(`  ${c.bold}${pad(entry.key, maxKey)}${c.reset}  ${display}`);
      } else if (entry.type === "optional" && entry.key in final && final[entry.key]) {
        const rendered = displayEnvValue(entry.key, final[entry.key]);
        const display = rendered.startsWith("<") ? c.dim + rendered + c.reset : rendered;
        console.log(`  ${c.bold}${pad(entry.key, maxKey)}${c.reset}  ${display}`);
      }
    }

    if (skillExtras.length > 0) {
      console.log();
      console.log(`  ${c.dim}── Skill environment ───────────────────────────${c.reset}`);
      for (const key of skillExtras.sort()) {
        const rendered = displayEnvValue(key, final[key]);
        const display = rendered.startsWith("<") ? c.dim + rendered + c.reset : rendered;
        console.log(`  ${c.bold}${pad(key, maxKey)}${c.reset}  ${display}`);
      }
    }

    console.log();
    const ok = await confirm({ message: "Write .env?", default: true });
    if (!ok) {
      console.log(`\n${c.yellow}Aborted.${c.reset}`);
      return;
    }

    const retainedExisting = withoutLegacyOwnerPresentation(existing);
    writeSetupEnv(EXAMPLE_PATH, ENV_PATH, final, retainedExisting);
    if (!IN_CONTAINER && !existsSync(WORKSPACE_PATH)) {
      mkdirSync(WORKSPACE_PATH);
    }
    if (IN_CONTAINER) {
      succeed("Done. Run `docker compose up -d` to start the agent.");
    } else {
      const cmd = process.platform === "win32"
        ? "docker compose up -d"
        : "UID=$(id -u) GID=$(id -g) docker compose up -d";
      succeed(`Done. Run \`${cmd}\` to start the agent.`);
    }
  } catch (err) {
    if (err && (err.name === "ExitPromptError" || err.name === "SetupOwnerDiscoveryCancelledError")) {
      console.log(`\n${c.yellow}Setup cancelled.${c.reset}`);
      return;
    }
    console.error(`${c.red}ERROR:${c.reset} setup failed; no configuration was replaced. Re-run setup after checking prerequisites.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
