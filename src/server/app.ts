import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { log } from "../lib/log.js";
import { addDashboardClient, closeDashboardClients } from "./sse.js";
import type { FelixEngine } from "../engine.js";
import { API_ROUTES, matchRoute } from "./routes.js";
import { handleWhatsAppWebhook } from "../adapters/whatsapp/index.js";
import { handleTelegramWebhook } from "../adapters/telegram/index.js";
import { readRequestBody, RequestBodyTooLargeError } from "./request-body.js";

const COOKIE_NAME = "felix_owner_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Where the built React app lives. In Docker (WORKDIR /app, `node dist/index.js`)
 * and in local builds this resolves to `<repo>/web/dist`; override with
 * WEB_DIST_DIR if the layout differs. Computed from this module's location so it
 * is independent of the process CWD.
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = process.env["WEB_DIST_DIR"]
  ? path.resolve(process.env["WEB_DIST_DIR"])
  : path.resolve(MODULE_DIR, "..", "..", "web", "dist");
const STATIC_INDEX = path.join(WEB_DIST_DIR, "index.html");

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

interface OwnerSession {
  id: string;
  expiresAt: number;
}

interface LoginAttempt {
  windowStartedAt: number;
  failures: number;
}

export async function startAppServer(
  cfg: AppConfig,
  engine: FelixEngine,
  preferredPort: number = 3000,
): Promise<{ server: http.Server; port: number }> {
  const sessions = new Map<string, OwnerSession>();
  const loginAttempts = new Map<string, LoginAttempt>();
  cleanupExpiredSessions(sessions);
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    const server = http.createServer(async (req, res) => {
      try {
        await routeRequest(cfg, engine, sessions, loginAttempts, req, res);
      } catch (error: any) {
        if (error instanceof RequestBodyTooLargeError) {
          if (!res.writableEnded) {
            sendJson(res, 413, { error: "request_body_too_large", max_bytes: error.maxBytes });
          }
          return;
        }
        log.error("owner.server_error", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          method: req.method,
          url: req.url,
        });
        if (!res.writableEnded) {
          sendJson(res, 500, { error: "internal_error" });
        }
      }
    });
    server.on("close", () => closeDashboardClients());
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
  loginAttempts: Map<string, LoginAttempt>,
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
    await handleLogin(cfg, sessions, loginAttempts, req, res);
    return;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    handleLogout(cfg, sessions, req, res);
    return;
  }

  // WhatsApp webhook — internal endpoint, no owner auth
  if (pathname === "/webhooks/whatsapp" && req.method === "POST") {
    log.info("whatsapp.webhook_request", { content_length: req.headers["content-length"] });
    await handleWhatsAppWebhook(cfg, engine, req, res);
    return;
  }

  // Telegram webhook — internal endpoint, no owner auth
  if (pathname === "/webhooks/telegram" && req.method === "POST") {
    log.info("telegram.webhook_request", { content_length: req.headers["content-length"] });
    await handleTelegramWebhook(cfg, engine, req, res);
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

  if (req.method === "GET" && pathname === "/events/dashboard") {
    const session = authenticate(sessions, req);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    addDashboardClient(cfg, req, res);
    return;
  }

  // Everything else: the static SPA bundle. Served unauthenticated — the React
  // app contains the login page itself and calls /api/* (which 401s) once booted.
  await serveStatic(req, res, pathname);
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
  loginAttempts: Map<string, LoginAttempt>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!cfg.OWNER_UI_SECRET) {
    sendJson(res, 500, { error: "owner_login_not_configured" });
    return;
  }
  const client = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  cleanupLoginAttempts(loginAttempts, now);
  const attempt = loginAttempts.get(client);
  if (attempt && now - attempt.windowStartedAt < LOGIN_WINDOW_MS && attempt.failures >= LOGIN_FAILURE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((attempt.windowStartedAt + LOGIN_WINDOW_MS - now) / 1000));
    res.setHeader("retry-after", String(retryAfter));
    sendJson(res, 429, { error: "too_many_login_attempts", retry_after_seconds: retryAfter });
    return;
  }
  const body = await readJsonBody(req);
  const payload = parseCredential(body);
  if (!payload.secret || !constantTimeEqual(payload.secret, cfg.OWNER_UI_SECRET)) {
    const current = loginAttempts.get(client);
    if (current && now - current.windowStartedAt < LOGIN_WINDOW_MS) {
      current.failures += 1;
    } else {
      loginAttempts.set(client, { windowStartedAt: now, failures: 1 });
    }
    sendJson(res, 401, { error: "invalid_secret" });
    return;
  }
  loginAttempts.delete(client);
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    id: sessionId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  setCookie(res, COOKIE_NAME, sessionId, SESSION_TTL_MS, cfg.OWNER_UI_SECURE_COOKIE);
  sendRedirect(res, 303, "/");
}

function handleLogout(
  cfg: AppConfig,
  sessions: Map<string, OwnerSession>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const session = authenticate(sessions, req);
  if (session) sessions.delete(session.id);
  clearCookie(res, COOKIE_NAME, cfg.OWNER_UI_SECURE_COOKIE);
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

function cleanupLoginAttempts(attempts: Map<string, LoginAttempt>, now: number): void {
  for (const [client, attempt] of attempts.entries()) {
    if (now - attempt.windowStartedAt >= LOGIN_WINDOW_MS) attempts.delete(client);
  }
}

/**
 * Serve the built React SPA from {@link WEB_DIST_DIR}. Unauthenticated by design
 * (the bundle contains its own login screen). Unknown non-asset paths fall back
 * to index.html so the client-side router can handle them.
 */
async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  let rel: string;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    // Malformed percent-encoding (e.g. "/%ZZ") — bad request, not a server error.
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  const target = path.resolve(WEB_DIST_DIR, rel);

  // Path-traversal guard: never serve outside the dist root.
  if (target !== WEB_DIST_DIR && !target.startsWith(WEB_DIST_DIR + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  const file = await readStaticFile(target);
  if (file) {
    sendFile(res, target, file, true);
    return;
  }

  // SPA fallback — let the client router resolve the route.
  const index = await readStaticFile(STATIC_INDEX);
  if (index) {
    sendFile(res, STATIC_INDEX, index, false);
    return;
  }

  // Bundle not built (e.g. running the server without `npm run build:web`).
  sendJson(res, 503, { error: "web_ui_not_built", hint: "run `npm run build:web` or build the Docker image" });
}

async function readStaticFile(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

function sendFile(res: http.ServerResponse, file: string, body: Buffer, allowCache: boolean): void {
  const ext = path.extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader("content-type", STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream");
  // Vite emits content-hashed filenames under /assets — safe to cache forever.
  // index.html and anything else must always revalidate.
  if (allowCache && file.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("cache-control", "no-cache");
  }
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}

function sendRedirect(res: http.ServerResponse, status: number, location: string): void {
  res.statusCode = status;
  res.setHeader("location", location);
  res.end();
}

function setCookie(
  res: http.ServerResponse,
  name: string,
  value: string,
  maxAgeMs: number,
  secure: boolean,
): void {
  res.setHeader(
    "set-cookie",
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`,
  );
}

function clearCookie(res: http.ServerResponse, name: string, secure: boolean): void {
  res.setHeader("set-cookie", `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
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

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const raw = await readRequestBody(req);
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
