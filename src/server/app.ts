import crypto from "node:crypto";
import http from "node:http";
import type { AppConfig } from "../config.js";
import { log } from "../lib/log.js";
import { OWNER_CLIENT_SCRIPT } from "./owner-client.js";
import type { FelixEngine } from "../engine.js";
import { API_ROUTES, matchRoute } from "./routes.js";

const COOKIE_NAME = "felix_owner_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface OwnerSession {
  id: string;
  expiresAt: number;
}

export async function startAppServer(
  cfg: AppConfig,
  engine: FelixEngine,
  preferredPort: number = cfg.HEALTH_PORT,
): Promise<{ server: http.Server; port: number }> {
  const sessions = new Map<string, OwnerSession>();
  cleanupExpiredSessions(sessions);
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    const server = http.createServer(async (req, res) => {
      try {
        await routeRequest(cfg, engine, sessions, req, res);
      } catch (error: any) {
        log.error("owner.server_error", { error: error?.message || String(error) });
        sendJson(res, 500, { error: "internal_error" });
      }
    });
    try {
      const actualPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          const address = server.address();
          if (address && typeof address === "object") {
            resolve(address.port);
            return;
          }
          resolve(port);
        });
      });
      return { server, port: actualPort };
    } catch {
      server.close();
    }
  }
  throw new Error(`Unable to bind owner server starting at port ${preferredPort}`);
}

async function routeRequest(
  cfg: AppConfig,
  engine: FelixEngine,
  sessions: Map<string, OwnerSession>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/login" && req.method === "POST") {
    await handleLogin(cfg, sessions, req, res);
    return;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    handleLogout(sessions, req, res);
    return;
  }

  if (pathname.startsWith("/api/")) {
    const session = authenticate(sessions, req);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    await routeApi(cfg, engine, req, res, pathname, url.searchParams);
    return;
  }

  const session = authenticate(sessions, req);
  if (!session) {
    sendHtml(res, 200, renderLoginPage());
    return;
  }
  sendHtml(res, 200, renderShellPage(pathname));
}

async function routeApi(
  cfg: AppConfig,
  engine: FelixEngine,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<void> {
  const match = matchRoute(API_ROUTES, req.method ?? "GET", pathname);
  if (!match) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  let bodyCache: Record<string, unknown> | undefined;
  await match.route.handler({
    cfg,
    engine,
    req,
    res,
    pathname,
    params: match.params,
    searchParams,
    async readBody() {
      if (!bodyCache) bodyCache = await readJsonBody(req);
      return bodyCache;
    },
    send(status, data) {
      sendJson(res, status, data);
    },
  });
}

async function handleLogin(
  cfg: AppConfig,
  sessions: Map<string, OwnerSession>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!cfg.OWNER_UI_SECRET) {
    sendJson(res, 500, { error: "owner_login_not_configured" });
    return;
  }
  const body = await readJsonBody(req);
  const payload = parseCredential(body);
  if (!payload.secret || !constantTimeEqual(payload.secret, cfg.OWNER_UI_SECRET)) {
    sendJson(res, 401, { error: "invalid_secret" });
    return;
  }
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    id: sessionId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  setCookie(res, COOKIE_NAME, sessionId, SESSION_TTL_MS);
  sendRedirect(res, 303, "/");
}

function handleLogout(
  sessions: Map<string, OwnerSession>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const session = authenticate(sessions, req);
  if (session) sessions.delete(session.id);
  clearCookie(res, COOKIE_NAME);
  sendRedirect(res, 303, "/");
}

function authenticate(
  sessions: Map<string, OwnerSession>,
  req: http.IncomingMessage,
): OwnerSession | null {
  cleanupExpiredSessions(sessions);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token) || null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function cleanupExpiredSessions(sessions: Map<string, OwnerSession>): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
    }
  }
}

function renderLoginPage(): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Felix Owner Login</title>
      <style>${baseStyles()}</style>
    </head>
    <body class="login-page">
      <div class="login-card panel">
        <div class="brand-mark">F</div>
        <div class="eyebrow">Felix Owner</div>
        <h1>Sign in</h1>
        <p class="muted" style="margin:0;font-size:14px">Enter the shared owner secret to open the internal operator console.</p>
        <form method="post" action="/api/login" class="form">
          <label>Owner secret<input type="password" name="secret" autofocus autocomplete="current-password" /></label>
          <button class="button" type="submit">Sign in</button>
        </form>
      </div>
    </body>
  </html>`;
}

function renderShellPage(pathname: string): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Felix Owner</title>
      <style>${baseStyles()}</style>
    </head>
    <body data-path="${escapeAttr(pathname)}">
      <div id="app"></div>
      <script>${OWNER_CLIENT_SCRIPT}</script>
    </body>
  </html>`;
}

function baseStyles(): string {
  return `
    :root {
      color-scheme: light;
      --bg: #f3f0ea;
      --panel: #fffdf8;
      --panel-alt: #f7f3ed;
      --text: #1a1d21;
      --muted: #6b7280;
      --line: #e2dcd4;
      --accent: #2f5d62;
      --accent-hover: #254d52;
      --accent-2: #7f5539;
      --good: #0f7535;
      --warn: #8a5b00;
      --bad: #b91c1c;
      --shadow: 0 4px 6px -1px rgba(31,35,40,0.06), 0 10px 30px -4px rgba(31,35,40,0.08);
      --shadow-sm: 0 1px 3px rgba(31,35,40,0.08);
      --t: 140ms ease;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; min-height: 100%; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      background:
        radial-gradient(ellipse at top left, rgba(47,93,98,0.09) 0%, transparent 50%),
        radial-gradient(ellipse at top right, rgba(127,85,57,0.07) 0%, transparent 50%),
        linear-gradient(180deg, #faf7f2 0%, var(--bg) 100%);
      color: var(--text);
    }
    a { color: var(--accent); text-decoration: none; transition: color var(--t); }
    a:hover { color: var(--accent-hover); text-decoration: underline; }
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
    .shell { max-width: 1440px; margin: 0 auto; padding: 28px 24px; }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; margin-bottom: 22px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
    }
    .topbar-brand { display: flex; align-items: center; gap: 14px; }
    .brand-mark {
      width: 40px; height: 40px; border-radius: 12px;
      background: var(--accent); color: white;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 18px; letter-spacing: -0.5px;
      flex-shrink: 0; box-shadow: var(--shadow-sm);
    }
    .topbar h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
    .panel h2, .panel h3 { margin: 0; }
    .eyebrow { text-transform: uppercase; letter-spacing: .1em; font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: 3px; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 20px; }
    .tab {
      padding: 8px 16px; border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.7);
      font-size: 14px; font-weight: 500;
      transition: background var(--t), border-color var(--t), color var(--t), box-shadow var(--t);
      cursor: pointer;
    }
    .tab:hover:not(.active) {
      background: rgba(255,255,255,0.95);
      border-color: rgba(47,93,98,0.35);
      color: var(--accent);
    }
    .tab.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: 0 2px 8px rgba(47,93,98,0.25); }
    .layout { display: grid; grid-template-columns: minmax(0, 2.3fr) minmax(300px, 1fr); gap: 20px; align-items: start; }
    .content, .sidebar { min-width: 0; }
    .panel {
      background: rgba(255,255,255,0.92);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: var(--shadow);
      padding: 20px;
      backdrop-filter: blur(10px);
      margin-bottom: 20px;
    }
    .panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .panel-head h2 { font-size: 18px; font-weight: 700; letter-spacing: -0.2px; }
    .panel-subpanel { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
    .muted { color: var(--muted); }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { border-bottom: 1px solid var(--line); padding: 11px 10px; text-align: left; vertical-align: middle; }
    .table thead th { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; color: var(--muted); background: var(--panel-alt); }
    .table thead th:first-child { border-radius: 8px 0 0 8px; }
    .table thead th:last-child { border-radius: 0 8px 8px 0; }
    .table tbody tr { transition: background var(--t); }
    .table tbody tr:hover { background: rgba(47,93,98,0.04); }
    .table tbody tr:last-child td { border-bottom: none; }
    .grid-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .grid-meta > div {
      background: var(--panel-alt);
      border: 1px solid rgba(214,208,199,0.6);
      border-radius: 12px;
      padding: 12px 14px;
    }
    .history-item, .artifact, .audit-row {
      background: var(--panel-alt);
      border: 1px solid rgba(214,208,199,0.6);
      border-radius: 12px;
      padding: 14px;
    }
    .history-item pre, .artifact pre { margin: 10px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    .history-title { font-weight: 600; margin-bottom: 4px; }
    .history-meta { color: var(--muted); font-size: 13px; }
    .stack { display: grid; gap: 10px; }
    .grid-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .grid-form .full { grid-column: 1 / -1; }
    label { display: grid; gap: 5px; font-size: 13px; font-weight: 500; color: var(--muted); }
    input, textarea {
      width: 100%;
      border: 1.5px solid var(--line);
      background: white;
      color: var(--text);
      border-radius: 10px;
      padding: 9px 12px;
      font: inherit;
      font-size: 14px;
      transition: border-color var(--t), box-shadow var(--t);
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(47,93,98,0.12);
    }
    input[readonly] { background: var(--panel-alt); color: var(--muted); cursor: default; }
    textarea { resize: vertical; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1.5px solid var(--accent);
      background: var(--accent);
      color: white;
      padding: 9px 16px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      transition: background var(--t), border-color var(--t), opacity var(--t), transform 80ms ease, box-shadow var(--t);
    }
    .button:hover { background: var(--accent-hover); border-color: var(--accent-hover); box-shadow: 0 2px 8px rgba(47,93,98,0.22); }
    .button:active { transform: scale(0.97); }
    .button-secondary { background: transparent; color: var(--accent); }
    .button-secondary:hover { background: rgba(47,93,98,0.06); border-color: var(--accent); box-shadow: none; }
    .button-sm { padding: 5px 12px; font-size: 13px; border-radius: 8px; }
    .button-inline { margin-right: 6px; margin-bottom: 4px; }
    .button-danger { border-color: var(--bad); background: var(--bad); }
    .button-danger:hover { background: #991b1b; border-color: #991b1b; }
    .action-group { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .badge {
      display: inline-flex; align-items: center;
      padding: 3px 9px; border-radius: 999px;
      background: #e4eff0; color: var(--accent);
      font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
    }
    .badge-warn { background: #fef3c7; color: var(--warn); }
    .badge-ok { background: #dcfce7; color: var(--good); }
    .badge-bad { background: #fee2e2; color: var(--bad); }
    .empty { padding: 32px 18px; text-align: center; color: var(--muted); font-size: 14px; }
    .empty-icon { font-size: 28px; margin-bottom: 10px; opacity: 0.45; }
    .error { color: var(--bad); }
    .link-back {
      display: inline-flex; align-items: center; gap: 6px;
      align-self: center;
      font-size: 13px; font-weight: 500;
      padding: 6px 14px; border-radius: 999px;
      border: 1.5px solid var(--line);
      background: rgba(255,255,255,0.75);
      color: var(--muted);
      transition: background var(--t), border-color var(--t), color var(--t);
    }
    .link-back:hover { background: white; border-color: var(--accent); color: var(--accent); text-decoration: none; }
    .audit-list { display: grid; gap: 8px; }
    .audit-row { display: grid; gap: 3px; }
    .audit-time { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .audit-summary { font-size: 13px; font-weight: 500; }
    .audit-meta { font-size: 11px; color: var(--muted); }
    .login-page { display: grid; place-items: center; min-height: 100vh; padding: 24px; }
    .login-card { max-width: 440px; width: 100%; }
    .login-card .brand-mark { width: 48px; height: 48px; font-size: 22px; margin-bottom: 20px; }
    .login-card h1 { margin-bottom: 6px; font-size: 26px; letter-spacing: -0.4px; }
    .login-card .form { margin-top: 22px; display: grid; gap: 14px; }
    .login-card .form label { color: var(--text); font-size: 14px; }
    .login-card .form .button { width: 100%; padding: 12px; font-size: 15px; }
    details.artifact summary { cursor: pointer; font-size: 14px; font-weight: 500; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-wrap { padding: 40px 20px; display: flex; flex-direction: column; align-items: center; gap: 14px; color: var(--muted); font-size: 14px; }
    .loading-spinner { width: 22px; height: 22px; border: 2.5px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.75s linear infinite; }
    .button.refreshing { opacity: 0.65; pointer-events: none; }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .grid-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .shell { padding: 16px; }
      .grid-meta, .grid-form { grid-template-columns: 1fr; }
      .panel-head { flex-direction: column; }
      .tabs { gap: 4px; }
      .tab { padding: 7px 12px; font-size: 13px; }
    }
  `;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

function sendRedirect(res: http.ServerResponse, status: number, location: string): void {
  res.statusCode = status;
  res.setHeader("location", location);
  res.end();
}

function setCookie(res: http.ServerResponse, name: string, value: string, maxAgeMs: number): void {
  res.setHeader("set-cookie", `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}

function clearCookie(res: http.ServerResponse, name: string): void {
  res.setHeader("set-cookie", `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function parseCookies(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return parseFormBody(raw);
  }
}

function parseFormBody(raw: string): Record<string, any> {
  const params = new URLSearchParams(raw);
  const out: Record<string, any> = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

function parseCredential(body: Record<string, any>): { secret?: string } {
  return { secret: typeof body.secret === "string" ? body.secret : undefined };
}


function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function escapeAttr(value: string): string {
  return value.replaceAll('"', '&quot;');
}
