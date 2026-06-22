#!/usr/bin/env node
import { spawn } from "node:child_process";
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
const WORKSPACE_PATH = IN_CONTAINER ? "/home/node/workspace" : join(ROOT, "workspace");

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
    ownerKeys: ["MATTERMOST_OWNER_USER_ID", "MATTERMOST_OWNER_DISPLAY"],
    ownerDefaults: { MATTERMOST_OWNER_DISPLAY: "Owner" },
    ownerHint: "Find your User ID: run curl -H 'Authorization: Bearer YOUR_TOKEN' YOUR_URL/api/v4/users/me | jq .id (or ask your admin: System Console → Users → select user → copy ID)",
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
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
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

function writeEnv(templatePath, outputPath, answers) {
  const template = parseTemplate(templatePath);
  const templateKeys = new Set();
  const lines = template.map((entry) => {
    if (entry.type !== "setting") return entry.raw;
    templateKeys.add(entry.key);
    if (entry.key in answers) {
      const eqIdx = entry.raw.indexOf("=");
      return entry.raw.slice(0, eqIdx + 1) + (answers[entry.key] ?? "");
    }
    return entry.raw;
  });

  const extra = Object.keys(answers)
    .filter((k) => !templateKeys.has(k) && answers[k])
    .sort();
  if (extra.length > 0) {
    lines.push("");
    lines.push("# ── Skill environment ───────────────────────────");
    for (const key of extra) lines.push(`${key}=${answers[key]}`);
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

    // ═══ Step 2: API Keys ═══════════════════════════════════════════════════

    step(2, 6, "API Keys");

    if (harness === "codex") {
      const codexModel = await input({
        message: "CODEX_MODEL [optional]:",
        default: existing.CODEX_MODEL || "gpt-5.4-mini",
      });
      wizard.CODEX_MODEL = codexModel;

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
        // OAuth: use CODEX_HOME to isolate auth from host's ~/.codex/
        const tmpHome = join(os.tmpdir(), `felix-oauth-${randomUUID().slice(0, 8)}`);
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
          wizard.OPENAI_CODEX_AUTH_JSON = authContent;
          wizard.OPENAI_API_KEY = "";
          succeed("Logged in via ChatGPT OAuth");
        }

        // Clean up temp dir
        try { rmSync(tmpHome, { recursive: true }); } catch {}
      }
    }

    if (harness === "opencode") {
      const ocKey = await promptRequired("OPENCODE_API_KEY", "opencode", existing);
      if (ocKey) wizard.OPENCODE_API_KEY = ocKey;

      const orKey = await input({
        message: `OPENROUTER_API_KEY [optional]:${existingHint(existing, "OPENROUTER_API_KEY") || ` ${c.dim}(Enter to skip)${c.reset}`}`,
        transformer: secretTransformer,
      });
      if (orKey) wizard.OPENROUTER_API_KEY = orKey;

      const ocModel = await input({
        message:
          "OPENCODE_MODEL [optional] (provider/model format):\n  Browse: https://models.dev\n  Docs:   https://opencode.ai/docs/providers",
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
      const ccKey = await promptRequired("ANTHROPIC_API_KEY", "claude-code", existing);
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
        { value: "mattermost", name: "Mattermost", checked: !!existing.MATTERMOST_TOKEN },
        { value: "discord", name: "Discord", checked: !!existing.DISCORD_TOKEN },
        { value: "slack", name: "Slack", checked: !!existing.SLACK_TOKEN },
      ],
    });

    let ownerSource = null;
    if (listenSources.length === 1) {
      ownerSource = listenSources[0];
      info(`  Owner channel: ${SOURCE_DEFS[ownerSource].label} (auto-selected)\n`);
    } else if (listenSources.length > 1) {
      info("  Select which source the owner will use.\n");
      ownerSource = await select({
        message: "Owner channel:",
        choices: listenSources.map((s) => ({ value: s, name: SOURCE_DEFS[s].label })),
      });
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
      const ownerBadge = src === ownerSource ? ` ${c.yellow}(owner)${c.reset}` : "";
      console.log(`\n${c.bold}${c.cyan}──${c.reset} ${c.bold}${def.label}${c.reset}${ownerBadge}`);

      for (const reqKey of def.required) {
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

      if (src === ownerSource) {
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

    // ── Clear owner keys on non-owner listening sources ────────────────────

    for (const src of listenSources) {
      if (src !== ownerSource) {
        const def = SOURCE_DEFS[src];
        for (const key of def.ownerKeys) {
          wizard[key] = "";
        }
      }
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
      for (const v of pendingSkillVars) {
        const hasExisting = existing && existing[v.key];
        const hint = hasExisting
          ? ` ${c.dim}(current: ${mask(existing[v.key])} — Enter to keep)${c.reset}`
          : "";
        const val = await input({
          message: `${v.key} — ${v.description} (${v.skill}) [${v.required ? "required" : "optional"}]:${hint}`,
          default: v.default || "",
          validate: (val) => {
            if (v.required && !val && !hasExisting) return `${v.key} is required by ${v.skill}`;
            return true;
          },
        });
        if (val) wizard[v.key] = val;
      }
    }

    // ═══ Step 6: Review ═════════════════════════════════════════════════════

    step(6, 6, "Review");

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
      if (!templateKeys.has(key) && value) {
        final[key] = value;
        skillExtras.push(key);
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

    writeEnv(EXAMPLE_PATH, ENV_PATH, final);
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
