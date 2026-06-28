#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { input, select, checkbox, confirm } from "@inquirer/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_CONTAINER = existsSync("/app");

const ROOT = IN_CONTAINER ? "/app" : join(__dirname, "..");
const EXAMPLE_PATH = IN_CONTAINER ? "/app/.env.example" : join(ROOT, ".env.example");
const ENV_PATH = IN_CONTAINER ? "/app/.env" : join(ROOT, ".env");
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
};

function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function stripAnsi(str) {
  return str.replace(/\x1b\[\d+(;\d+)*m/g, "");
}

function box(text, color = c.cyan) {
  const lines = text.split("\n");
  const maxW = Math.max(...lines.map((l) => stripAnsi(l).length));
  const top = `${color}${c.bold}╔${"═".repeat(maxW + 4)}╗${c.reset}`;
  const bottom = `${color}${c.bold}╚${"═".repeat(maxW + 4)}╝${c.reset}`;
  console.log(top);
  for (const line of lines) {
    const vis = stripAnsi(line).length;
    const left = Math.floor((maxW - vis) / 2);
    const right = maxW - vis - left;
    console.log(`${color}${c.bold}║${c.reset}  ${" ".repeat(left)}${line}${" ".repeat(right)}  ${color}${c.bold}║${c.reset}`);
  }
  console.log(bottom);
}

function step(n, total, label) {
  console.log(`\n${c.cyan}${c.bold}▌${c.reset} ${c.bold}Step ${n}/${total}${c.reset} ${c.dim}·${c.reset} ${c.yellow}${label}${c.reset}\n`);
}

function succeed(msg) {
  console.log(`\n${c.green}${c.bold}✓${c.reset}  ${msg}`);
}

function warn(msg) {
  console.log(`${c.yellow}${c.bold}⚠${c.reset}  ${msg}`);
}

function info(msg) {
  console.log(`${c.dim}${msg}${c.reset}`);
}

// ── Constants ──────────────────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  "OWNER_UI_SECRET",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_AUTH_JSON",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "NINEROUTER_KEY",
  "ANTHROPIC_API_KEY",
  "MATTERMOST_TOKEN",
  "DISCORD_TOKEN",
  "SLACK_TOKEN",
  "SLACK_APP_TOKEN",
]);

const SOURCE_DEFS = {
  mattermost: {
    label: "Mattermost",
    required: ["MATTERMOST_URL", "MATTERMOST_BOT_TOKEN"],
    optional: {
      MATTERMOST_BOT_USERNAME: "",
      MATTERMOST_BOT_DISPLAY: "Felix",
    },
    ownerKeys: ["MATTERMOST_OWNER_USER_ID", "MATTERMOST_OWNER_USERNAME", "MATTERMOST_OWNER_DISPLAY"],
    ownerDefaults: { MATTERMOST_OWNER_DISPLAY: "Owner" },
    ownerHint: "Enter your Mattermost username — the script will look up your User ID automatically.",
  },
  discord: {
    label: "Discord",
    required: ["DISCORD_BOT_TOKEN"],
    optional: {},
    ownerKeys: ["DISCORD_OWNER_USER_ID", "DISCORD_OWNER_DISPLAY"],
    ownerDefaults: { DISCORD_OWNER_DISPLAY: "Owner" },
    ownerHint: "Find your User ID: Enable Developer Mode (Settings → Advanced → Developer Mode), then right-click your name → Copy User ID",
  },
  slack: {
    label: "Slack",
    required: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    optional: {},
    ownerKeys: ["SLACK_OWNER_USER_ID", "SLACK_OWNER_DISPLAY"],
    ownerDefaults: { SLACK_OWNER_DISPLAY: "Owner" },
    ownerHint: "Find your User ID: Click your name → View profile → ⋯ → Copy member ID",
  },
  whatsapp: {
    label: "WhatsApp (via wacli)",
    required: ["WHATSAPP_BOT_NAME"],
    optional: {},
    ownerKeys: ["WHATSAPP_OWNER_DISPLAY"],
    ownerDefaults: { WHATSAPP_OWNER_DISPLAY: "Owner" },
    ownerHint: "Enter your WhatsApp phone number (with country code, no +). The JID will be derived automatically.",
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function mask(value) {
  if (!value) return "<not set>";
  if (value.length <= 6) return "*".repeat(value.length);
  return "****" + value.slice(-4);
}

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

function parseTemplate(path) {
  const raw = readFileSync(path, "utf8");
  return raw.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { type: "blank", raw: line };
    if (trimmed.startsWith("#")) return { type: "comment", raw: line };
    const eq = trimmed.indexOf("=");
    if (eq < 1) return { type: "comment", raw: line };
    return {
      type: "setting",
      raw: line,
      key: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).trim(),
    };
  });
}

function writeEnv(templatePath, outputPath, answers, existing) {
  const template = parseTemplate(templatePath);
  const templateKeys = new Set();
  const lines = template.map((entry) => {
    if (entry.type !== "setting") return entry.raw;
    templateKeys.add(entry.key);
    if (entry.key in answers) {
      const eqIdx = entry.raw.indexOf("=");
      let val = answers[entry.key] ?? "";
      if (/[\s"'#]/.test(val) || val.includes("\n")) {
        val = "'" + val.replace(/'/g, "'\\''") + "'";
      }
      return entry.raw.slice(0, eqIdx + 1) + val;
    }
    return entry.raw;
  });

  const extra = new Set([
    ...Object.keys(answers).filter((k) => !templateKeys.has(k)),
    ...Object.keys(existing || {}).filter((k) => !templateKeys.has(k) && !(k in answers) && existing[k]),
  ]);
  if (extra.size > 0) {
    lines.push("");
    lines.push("# ── Extra environment ──────────────────────────");
    for (const key of [...extra].sort()) {
      let val = key in answers ? (answers[key] ?? "") : existing[key];
      if (/[\s"'#]/.test(val) || val.includes("\n")) {
        val = "'" + val.replace(/'/g, "'\\''") + "'";
      }
      lines.push(`${key}=${val}`);
    }
  }

  writeFileSync(outputPath, lines.join("\n") + "\n");
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

function secretTransformer(value, { isFinal }) {
  if (isFinal) return "*".repeat(value.length);
  if (value.length === 0) return `${c.dim}(empty)${c.reset}`;
  return "*".repeat(value.length - 1) + value[value.length - 1];
}

function existingHint(existing, key) {
  if (existing && key in existing && existing[key]) {
    return ` ${c.dim}(current: ${mask(existing[key])} — Enter to keep)${c.reset}`;
  }
  return "";
}

async function promptRequired(key, src, existing) {
  const hasExisting = existing && existing[key];
  const hint = hasExisting
    ? ` ${c.dim}(current: ${mask(existing[key])} — Enter to keep)${c.reset}`
    : "";
  const val = await input({
    message: `${key} [required]:${hint}`,
    transformer: secretTransformer,
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
      if (!fm || fm.enabled === false) continue;
      if (!Array.isArray(fm.env)) continue;

      for (const entry of fm.env) {
        if (!entry || !entry.key || seen.has(entry.key)) continue;
        seen.add(entry.key);
        vars.push({
          key: entry.key,
          description: entry.description || "",
          required: entry.required === true,
          default: entry.default || "",
          skill: fm.id || d.name,
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

async function main() {
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

    box(
      [
        "",
        `${c.bold}Felix Agent Setup${c.reset}`,
        "",
        `Configure your environment interactively.`,
        `Press ${c.bold}Ctrl+C${c.reset} to cancel at any time.`,
        "",
      ].join("\n"),
    );

    if (existingExists) {
      info("\n  Existing .env found — values are pre-filled.");
      info("  Press Enter to keep, type to change.");
    }

    // ═══ Step 1: Harness ═══════════════════════════════════════════════════

    step(1, 6, "Harness");

    const harness = await select({
      message: "Select LLM backend:",
      choices: [
        { value: "codex", name: "codex — OpenAI Codex CLI" },
        { value: "opencode", name: "opencode — OpenCode CLI" },
        { value: "claude-code", name: "claude-code — Claude Code CLI by Anthropic" },
      ],
      default: existing.HARNESS || "codex",
    });
    wizard.HARNESS = harness;

    const ninerouterEnabled = await confirm({
      message: "Enable 9router override for the selected harness?",
      default: existing.NINEROUTER_ENABLED === "true",
    });
    wizard.NINEROUTER_ENABLED = ninerouterEnabled ? "true" : "false";

    if (ninerouterEnabled) {
      info("\n  9router will override the active harness API key, base URL, and model.\n");
      info("  Enter the bare gateway base, e.g. https://host.example (no /v1).");
      info("  Codex/Opencode append /v1; Claude Code appends /v1/messages.\n");

      const nrKey = await promptRequired("NINEROUTER_KEY", "9router", existing);
      if (nrKey) wizard.NINEROUTER_KEY = nrKey;

      const nrBaseUrl = await input({
        message: "NINEROUTER_URL [required] (e.g. https://9router.example.com):",
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
        message: "NINEROUTER_MODEL [required]:",
        default: existing.NINEROUTER_MODEL || "",
        validate: (v) => v.trim().length > 0 ? true : "NINEROUTER_MODEL is required when 9router is enabled",
      });
      wizard.NINEROUTER_MODEL = nrModel;
    } else {
      wizard.NINEROUTER_KEY = "";
      wizard.NINEROUTER_URL = "";
      wizard.NINEROUTER_MODEL = "";
    }

    // ═══ Step 2: API Keys ═══════════════════════════════════════════════════

    step(2, 6, "API Keys");

    if (harness === "codex") {
      const codexModel = await input({
        message: "CODEX_MODEL [optional]:",
        default: existing.CODEX_MODEL || "gpt-5.4-mini",
      });
      wizard.CODEX_MODEL = codexModel;

      if (ninerouterEnabled) {
        info("  9router is enabled, so Codex will use NINEROUTER_KEY at runtime.\n");
        const oaiKey = await input({
          message: `OPENAI_API_KEY [optional fallback]:${existingHint(existing, "OPENAI_API_KEY") || ` ${c.dim}(Enter to skip)${c.reset}`}`,
          transformer: secretTransformer,
        });
        if (oaiKey) wizard.OPENAI_API_KEY = oaiKey;
      } else {
        const authMethod = await select({
          message: "Codex authentication method:",
          choices: [
            { value: "api-key", name: "api-key — Use OpenAI API key" },
            { value: "oauth", name: "oauth — Login with ChatGPT Plus account (device auth)" },
          ],
          default: existing.OPENAI_CODEX_AUTH_JSON ? "oauth" : "api-key",
        });

        if (authMethod === "api-key") {
          const oaiKey = await promptRequired("OPENAI_API_KEY", "codex", existing);
          if (oaiKey) wizard.OPENAI_API_KEY = oaiKey;
        } else {
          // OAuth: use a temp home under workspace
          const tmpHome = join(WORKSPACE_PATH, `.felix-oauth-${randomUUID().slice(0, 8)}`);
          mkdirSync(tmpHome, { recursive: true });

          info("\n  Launching device auth...");
          info("  A browser window will open. Enter the code shown below.\n");

          const child = spawn("codex", ["login", "--device-auth"], {
            env: { ...process.env, CODEX_HOME: tmpHome },
            stdio: "inherit",
          });
          const exitCode = await new Promise((resolve) => {
            child.on("close", (code) => resolve(code ?? -1));
          });

          if (exitCode !== 0) {
            warn("codex login failed. Falling back to API key method.");
            const oaiKey = await promptRequired("OPENAI_API_KEY", "codex", existing);
            if (oaiKey) wizard.OPENAI_API_KEY = oaiKey;
          } else {
            const authPath = join(tmpHome, "auth.json");
            const authContent = readFileSync(authPath, "utf8");
            wizard.OPENAI_CODEX_AUTH_JSON = JSON.stringify(JSON.parse(authContent));
            wizard.OPENAI_API_KEY = "";
            succeed("Logged in via ChatGPT OAuth");
          }

          // Clean up temp dir
          try { rmSync(tmpHome, { recursive: true }); } catch {}
        }
      }
    }

    if (harness === "opencode") {
      const ocKey = ninerouterEnabled
        ? await input({
            message: `OPENCODE_API_KEY [optional fallback]:${existingHint(existing, "OPENCODE_API_KEY") || ` ${c.dim}(Enter to skip)${c.reset}`}`,
            transformer: secretTransformer,
          })
        : await promptRequired("OPENCODE_API_KEY", "opencode", existing);
      if (ocKey) wizard.OPENCODE_API_KEY = ocKey;

      const orKey = await input({
        message: `OPENROUTER_API_KEY [optional]:${existingHint(existing, "OPENROUTER_API_KEY") || ` ${c.dim}(Enter to skip)${c.reset}`}`,
        transformer: secretTransformer,
      });
      if (orKey) wizard.OPENROUTER_API_KEY = orKey;

      const ocModel = await input({
        message:
          "OPENCODE_MODEL [optional] (provider/model format):\n  Browse: https://models.dev",
        default: existing.OPENCODE_MODEL || "opencode/deepseek-v4-flash-free",
      });
      wizard.OPENCODE_MODEL = ocModel;

      const ocVariant = await input({
        message: "OPENCODE_VARIANT [optional] (reasoning effort):",
        default: existing.OPENCODE_VARIANT || "high",
      });
      wizard.OPENCODE_VARIANT = ocVariant;
    }

    if (harness === "claude-code") {
      const ccKey = ninerouterEnabled
        ? await input({
            message: `ANTHROPIC_API_KEY [optional fallback]:${existingHint(existing, "ANTHROPIC_API_KEY") || ` ${c.dim}(Enter to skip)${c.reset}`}`,
            transformer: secretTransformer,
          })
        : await promptRequired("ANTHROPIC_API_KEY", "claude-code", existing);
      if (ccKey) wizard.ANTHROPIC_API_KEY = ccKey;

      const ccModel = await input({
        message: "CLAUDE_CODE_MODEL [optional] (alias: sonnet, opus, haiku, fable or full model ID):",
        default: existing.CLAUDE_CODE_MODEL || "sonnet",
      });
      wizard.CLAUDE_CODE_MODEL = ccModel;
    }

    // ═══ Step 3: Owner Console ══════════════════════════════════════════════

    step(3, 6, "Owner Console");

    info("  Enter a secret for the owner web console.");
    info("  Press Enter to auto-generate one.\n");

    const secret = await input({
      message: "OWNER_UI_SECRET [optional]:",
      default: existing.OWNER_UI_SECRET || randomUUID(),
    });
    wizard.OWNER_UI_SECRET = secret;

    // ═══ Step 4: Sources ════════════════════════════════════════════════════

    step(4, 6, "Sources");

    info("  Select chat sources Felix will listen to.\n");

    const listenSources = await checkbox({
      message: "Listening sources:",
      choices: [
        { value: "mattermost", name: "Mattermost", checked: !!(existing.MATTERMOST_BOT_TOKEN || existing.MATTERMOST_TOKEN) },
        { value: "discord", name: "Discord", checked: !!(existing.DISCORD_BOT_TOKEN || existing.DISCORD_TOKEN) },
        { value: "slack", name: "Slack", checked: !!(existing.SLACK_BOT_TOKEN || existing.SLACK_TOKEN) },
        { value: "whatsapp", name: "WhatsApp (via wacli)", checked: !!existing.WHATSAPP_BOT_NAME },
      ],
    });

    if (listenSources.length > 1) {
      info("  Where should permission notifications go?\n");
      const notifyChannel = await select({
        message: "Permission notification channel:",
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
      }
    }

    // ── Cascading prompts per source ───────────────────────────────────────

    for (const src of listenSources) {
      const def = SOURCE_DEFS[src];
      console.log(`\n${c.bold}${c.cyan}──${c.reset} ${c.bold}${def.label}${c.reset}`);

      for (const reqKey of def.required) {
        // WHATSAPP_BOT_NAME handled in the WhatsApp block (plain input, no masking)
        if (src === "whatsapp" && reqKey === "WHATSAPP_BOT_NAME") continue;
        const val = await promptRequired(reqKey, src, existing);
        if (val) wizard[reqKey] = val;
      }

      for (const [optKey, fallback] of Object.entries(def.optional)) {
        const val = await input({
          message: `${optKey} [optional]:`,
          default: existing[optKey] || fallback,
        });
        wizard[optKey] = val;
      }

      if (src === "mattermost") {
          const mmUrl = wizard.MATTERMOST_URL || existing.MATTERMOST_URL;
          const mmToken = wizard.MATTERMOST_BOT_TOKEN || existing.MATTERMOST_BOT_TOKEN;
          const existingUsername = existing.MATTERMOST_OWNER_USERNAME || wizard.MATTERMOST_OWNER_USERNAME || "";
          const existingDisplay = existing.MATTERMOST_OWNER_DISPLAY || wizard.MATTERMOST_OWNER_DISPLAY || def.ownerDefaults.MATTERMOST_OWNER_DISPLAY;

          const username = await input({
            message: `MATTERMOST_OWNER_USERNAME [optional] (your login username for API lookups):`,
            default: existingUsername,
          });
          wizard.MATTERMOST_OWNER_USERNAME = username;

          if (mmUrl && mmToken && username) {
            info("  Looking up your User ID and display name via Mattermost API...\n");
            try {
              const res = await fetch(`${mmUrl}/api/v4/users/username/${encodeURIComponent(username)}`, {
                headers: { Authorization: `Bearer ${mmToken}` },
              });
              if (res.ok) {
                const user = await res.json();
                wizard.MATTERMOST_OWNER_USER_ID = user.id;
                succeed(`Found User ID: ${user.id}`);
                if (user.nickname || user.first_name || user.last_name) {
                  const fetchedDisplay = user.nickname || [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
                  info(`  Fetched display name: ${fetchedDisplay}`);
                  if (!existingDisplay || existingDisplay === def.ownerDefaults.MATTERMOST_OWNER_DISPLAY) {
                    wizard.MATTERMOST_OWNER_DISPLAY = fetchedDisplay;
                  }
                }
              } else {
                warn(`API lookup failed (${res.status}). Please enter manually.`);
                const val = await input({
                  message: `MATTERMOST_OWNER_USER_ID [optional]:`,
                  default: existing.MATTERMOST_OWNER_USER_ID || ""
                });
                wizard.MATTERMOST_OWNER_USER_ID = val;
              }
            } catch (err) {
              warn(`API lookup failed: ${err.message}. Please enter manually.`);
              const val = await input({
                message: `MATTERMOST_OWNER_USER_ID [optional]:`,
                default: existing.MATTERMOST_OWNER_USER_ID || ""
              });
              wizard.MATTERMOST_OWNER_USER_ID = val;
            }
          } else {
            const val = await input({
              message: `MATTERMOST_OWNER_USER_ID [optional]:`,
              default: existing.MATTERMOST_OWNER_USER_ID || ""
            });
            wizard.MATTERMOST_OWNER_USER_ID = val;
          }

          const display = await input({
            message: `MATTERMOST_OWNER_DISPLAY [optional] (your display name shown in channels):`,
            default: existingDisplay,
          });
          wizard.MATTERMOST_OWNER_DISPLAY = display;
        } else if (src === "whatsapp") {
          // WHATSAPP_BOT_NAME — plain input, no masking
          const botName = await input({
            message: `WHATSAPP_BOT_NAME [required] (letters, digits, underscores):`,
            default: existing.WHATSAPP_BOT_NAME || "",
            validate: (v) => v.trim().length > 0 ? true : "WHATSAPP_BOT_NAME is required for WhatsApp",
          });
          wizard.WHATSAPP_BOT_NAME = botName;

          // WHATSAPP_BOT_ALIASES — plain input, optional
          const aliases = await input({
            message: `WHATSAPP_BOT_ALIASES [optional] (comma-separated short names, e.g. f,F,lix):`,
            default: existing.WHATSAPP_BOT_ALIASES || "",
            validate: (v) => /^[A-Za-z0-9_,]*$/.test(v) ? true : "Only letters, digits, underscores, and commas allowed",
          });
          wizard.WHATSAPP_BOT_ALIASES = aliases;

          // WHATSAPP_OWNER_PHONE → derive WHATSAPP_OWNER_JID
          info(`\n  ${def.ownerHint}`);
          const existingJid = existing.WHATSAPP_OWNER_JID || "";
          const existingPhone = existingJid ? existingJid.split("@")[0] : "";
          const phone = await input({
            message: `WHATSAPP_OWNER_PHONE [optional] (e.g. 6281234567890):`,
            default: existingPhone,
          });
          if (phone) {
            wizard.WHATSAPP_OWNER_JID = phone + "@s.whatsapp.net";
          }

          const display = await input({
            message: `WHATSAPP_OWNER_DISPLAY [optional]:`,
            default: existing.WHATSAPP_OWNER_DISPLAY || def.ownerDefaults.WHATSAPP_OWNER_DISPLAY,
          });
          wizard.WHATSAPP_OWNER_DISPLAY = display;

          const wacliBin = existing.WHATSAPP_WACLI_BIN || "wacli";
          const authStatus = checkSetupWacliAuth(wacliBin);
          if (authStatus.status === "authenticated") {
            succeed(`wacli is already paired${authStatus.jid ? ` as ${authStatus.jid}` : ""}.`);
          } else if (authStatus.status === "locked") {
            warn("wacli store is locked, likely by the running Felix container. Skipping pairing.");
            info("  Stop the container before re-pairing, or keep the existing logged-in session.");
          } else {
            info("\n  Pairing wacli with WhatsApp...");
            info("  A QR code will appear. Scan it with WhatsApp on your phone.");
            info("  WhatsApp → Settings → Linked Devices → Link a Device\n");

            const { exitCode, error } = await runWacliAuth(wacliBin);
            if (exitCode !== 0) {
              warn(`wacli auth failed${error ? `: ${error}` : ""}. Run \`${wacliBin} auth\` manually.`);
            } else {
              succeed("WhatsApp paired successfully.");
            }
          }
        } else {
          info(`\n  ${def.ownerHint}`);
          for (const ownerKey of def.ownerKeys) {
            const val = await input({
              message: `${ownerKey} [optional]:`,
              default: existing[ownerKey] || def.ownerDefaults[ownerKey] || "",
            });
            wizard[ownerKey] = val;
          }
        }
    }

    if (listenSources.length === 0) {
      warn("No sources selected. You can re-run setup later.\n");
    }

    // ═══ Step 5: Skill Environment ══════════════════════════════════════════

    step(5, 6, "Skill Environment");

    const skillDirs = [join(ROOT, "skills")];
    const catalogDir = join(WORKSPACE_PATH, "catalog", "skills");
    if (existsSync(catalogDir)) skillDirs.push(catalogDir);

    const skillVars = await scanSkillEnv(skillDirs);
    const pendingSkillVars = skillVars.filter((v) => !(v.key in wizard));

    if (pendingSkillVars.length === 0) {
      info("  No skill environment variables to configure.\n");
    } else {
      info("  Bundled skills request these environment variables.\n");

      // Group by skill
      const bySkill = new Map();
      for (const v of pendingSkillVars) {
        if (!bySkill.has(v.skill)) bySkill.set(v.skill, []);
        bySkill.get(v.skill).push(v);
      }

      for (const [skill, vars] of bySkill) {
        console.log(`\n${c.bold}${c.cyan}──${c.reset} ${c.bold}${skill}${c.reset}`);
        for (const v of vars) {
          const hasExisting = existing && existing[v.key];
          const hint = hasExisting
            ? ` ${c.dim}(current: ${mask(existing[v.key])} — Enter to keep)${c.reset}`
            : "";
          const val = await input({
            message: `${v.key} — ${v.description} [${v.required ? "required" : "optional"}]:${hint}`,
            default: hasExisting ? existing[v.key] : (v.default || ""),
            validate: (val) => {
              if (v.required && !val && !hasExisting) return `${v.key} is required by ${skill}`;
              return true;
            },
          });
          if (val) wizard[v.key] = val;
        }
      }
    }

    // ═══ Step 6: Review ═════════════════════════════════════════════════════

    step(6, 6, "Review");

    if (wizard.NINEROUTER_ENABLED === "true") {
      info("\n  9router override is enabled — it will replace the selected harness key, base URL, and model at runtime.");
    }

    const template = parseTemplate(EXAMPLE_PATH);
    const templateKeys = new Set();
    const final = {};
    for (const entry of template) {
      if (entry.type !== "setting") continue;
      templateKeys.add(entry.key);
      if (entry.key in wizard) {
        final[entry.key] = wizard[entry.key];
      } else if (entry.key in existing) {
        final[entry.key] = existing[entry.key];
      } else {
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

    for (const entry of template) {
      if (entry.type === "comment" && /^# ──/.test(entry.raw)) {
        console.log(`\n  ${c.dim}${entry.raw.slice(2)}${c.reset}`);
      } else if (entry.type === "setting" && entry.key in final) {
        const display = SECRET_KEYS.has(entry.key)
          ? c.dim + mask(final[entry.key]) + c.reset
          : final[entry.key] || `${c.dim}<not set>${c.reset}`;
        console.log(`  ${c.bold}${pad(entry.key, maxKey)}${c.reset}  ${display}`);
      }
    }

    if (skillExtras.length > 0) {
      console.log(`\n  ${c.dim}── Skill environment ───────────────────────────${c.reset}`);
      for (const key of skillExtras.sort()) {
        console.log(`  ${c.bold}${pad(key, maxKey)}${c.reset}  ${final[key]}`);
      }
    }

    const ok = await confirm({ message: "\nWrite .env?", default: true });
    if (!ok) {
      console.log(`\n${c.yellow}Aborted.${c.reset}`);
      return;
    }

    writeEnv(EXAMPLE_PATH, ENV_PATH, final, existing);
    if (IN_CONTAINER) {
      // Enforce restrictive permissions on .env (Unix only)
      if (process.platform !== "win32") {
        try { chmodSync(ENV_PATH, 0o600); } catch {}
      }
    } else if (!existsSync(WORKSPACE_PATH)) {
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
    if (err && err.name === "ExitPromptError") {
      console.log(`\n${c.yellow}Setup cancelled.${c.reset}\n`);
      process.exit(0);
    }
    throw err;
  }
}

main();
