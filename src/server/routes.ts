import type http from "node:http";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { FelixEngine } from "../engine.js";
import {
  listSessionSummaries,
  loadSessionDetail,
  loadChatTimeline,
  listSkillsForUi,
  loadSkillForUi,
  saveSkillForUi,
  deleteSkillForUi,
  listContactsForUi,
  loadContactForUi,
  saveContactForUi,
  createContactForUi,
  listAuditForUi,
  addSkillAudit,
  addContactAudit,
  addApprovalAudit,
} from "../owner-data.js";
import { listApprovalRecords } from "../slices/approvals/index.js";

// ---------------------------------------------------------------------------
// Route context
// ---------------------------------------------------------------------------

export interface RouteContext {
  cfg: AppConfig;
  engine: FelixEngine;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  params: Record<string, string>;
  searchParams: URLSearchParams;
  readBody(): Promise<Record<string, unknown>>;
  send(status: number, data: unknown): void;
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface Route {
  method: HttpMethod;
  /** Pattern segments. Use `:name` for a single captured segment, `**` at the
   * end to capture all remaining segments (joined with "/") as `params["**"]`. */
  pattern: string;
  handler(ctx: RouteContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

export function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  const urlParts = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternParts = route.pattern.split("/").filter(Boolean);
    const params: Record<string, string> = {};
    let matched = true;
    let ui = 0;
    for (let pi = 0; pi < patternParts.length; pi++) {
      const seg = patternParts[pi];
      if (seg === "**") {
        params["**"] = urlParts.slice(ui).join("/");
        ui = urlParts.length;
        break;
      }
      if (ui >= urlParts.length) {
        matched = false;
        break;
      }
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = decodeURIComponent(urlParts[ui]!);
      } else if (seg !== urlParts[ui]) {
        matched = false;
        break;
      }
      ui++;
    }
    if (matched && ui === urlParts.length) {
      return { route, params };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const API_ROUTES: Route[] = [
  // Sessions
  {
    method: "GET",
    pattern: "/api/sessions",
    async handler({ cfg, send }) {
      send(200, { items: await listSessionSummaries(cfg) });
    },
  },
  {
    method: "GET",
    pattern: "/api/sessions/:threadKey",
    async handler({ cfg, params, send }) {
      const detail = await loadSessionDetail(cfg, params["threadKey"]!);
      if (!detail) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, detail);
    },
  },
  {
    method: "GET",
    pattern: "/api/sessions/:threadKey/messages",
    async handler({ cfg, params, send }) {
      const messages = await loadChatTimeline(cfg, params["threadKey"]!);
      if (!messages) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, { items: messages });
    },
  },

  // Skills
  {
    method: "GET",
    pattern: "/api/skills",
    async handler({ cfg, send }) {
      send(200, { items: await listSkillsForUi(cfg) });
    },
  },
  {
    method: "GET",
    pattern: "/api/skills/:skillId",
    async handler({ cfg, params, send }) {
      const skill = await loadSkillForUi(cfg, params["skillId"]!);
      if (!skill) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, skill);
    },
  },
  {
    method: "POST",
    pattern: "/api/skills",
    async handler({ cfg, engine, readBody, send }) {
      const body = await readBody();
      const skillId = validateId(String(body["id"] ?? ""));
      if (!skillId) {
        send(400, { error: "invalid_skill_id" });
        return;
      }
      const existing = await loadSkillForUi(cfg, skillId);
      if (existing) {
        send(409, { error: "skill_exists" });
        return;
      }
      const saved = await saveSkillForUi(cfg, skillId, normalizeSkillBody(body));
      await engine.refreshSkills();
      await addSkillAudit(cfg, skillId, "create", `Created skill ${skillId}`, { path: saved.path });
      send(201, saved);
    },
  },
  {
    method: "PUT",
    pattern: "/api/skills/:skillId",
    async handler({ cfg, engine, params, readBody, send }) {
      const skillId = validateId(params["skillId"]!);
      if (!skillId) {
        send(400, { error: "invalid_skill_id" });
        return;
      }
      const existing = await loadSkillForUi(cfg, skillId);
      if (!existing) {
        send(404, { error: "not_found" });
        return;
      }
      const body = await readBody();
      const saved = await saveSkillForUi(cfg, skillId, normalizeSkillBody(body));
      await engine.refreshSkills();
      await addSkillAudit(cfg, skillId, "update", `Updated skill ${skillId}`, { path: saved.path });
      send(200, saved);
    },
  },
  {
    method: "DELETE",
    pattern: "/api/skills/:skillId",
    async handler({ cfg, engine, params, send }) {
      const skillId = validateId(params["skillId"]!);
      if (!skillId) {
        send(400, { error: "invalid_skill_id" });
        return;
      }
      const existing = await loadSkillForUi(cfg, skillId);
      if (!existing) {
        send(404, { error: "not_found" });
        return;
      }
      await deleteSkillForUi(cfg, skillId);
      await engine.refreshSkills();
      await addSkillAudit(cfg, skillId, "delete", `Deleted skill ${skillId}`);
      send(200, { ok: true });
    },
  },

  // Contacts — userId may contain slashes, so use ** after source
  {
    method: "GET",
    pattern: "/api/contacts",
    async handler({ cfg, send }) {
      send(200, { items: await listContactsForUi(cfg) });
    },
  },
  {
    method: "GET",
    pattern: "/api/contacts/:source/**",
    async handler({ cfg, params, send }) {
      const { source, userId } = extractContactParams(params);
      if (!source || !userId) {
        send(400, { error: "invalid_contact_path" });
        return;
      }
      const contact = await loadContactForUi(cfg, source, userId);
      if (!contact) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, contact);
    },
  },
  {
    method: "PUT",
    pattern: "/api/contacts/:source/**",
    async handler({ cfg, params, readBody, send }) {
      const { source, userId } = extractContactParams(params);
      if (!source || !userId) {
        send(400, { error: "invalid_contact_path" });
        return;
      }
      const existing = await loadContactForUi(cfg, source, userId);
      if (!existing) {
        send(404, { error: "not_found" });
        return;
      }
      const body = await readBody();
      const saved = await saveContactForUi(cfg, source, userId, normalizeContactBody(body));
      await addContactAudit(cfg, source, userId, "update", `Updated contact ${source}:${userId}`, {
        permissions: saved.allowed_permissions,
      });
      send(200, saved);
    },
  },
  {
    method: "POST",
    pattern: "/api/contacts/:source/**",
    async handler({ cfg, params, readBody, send }) {
      const { source, userId } = extractContactParams(params);
      if (!source || !userId) {
        send(400, { error: "invalid_contact_path" });
        return;
      }
      const body = await readBody();
      try {
        const saved = await createContactForUi(cfg, source, userId, normalizeContactBody(body));
        await addContactAudit(cfg, source, userId, "create", `Created contact ${source}:${userId}`, {
          permissions: saved.allowed_permissions,
        });
        send(201, saved);
      } catch (error: any) {
        if (error?.message === "contact_exists") {
          send(409, { error: "contact_exists" });
          return;
        }
        throw error;
      }
    },
  },

  // Approvals
  {
    method: "GET",
    pattern: "/api/approvals",
    async handler({ cfg, send }) {
      send(200, { items: await listApprovalRecords(cfg) });
    },
  },
  {
    method: "POST",
    pattern: "/api/approvals/:approvalId/:action",
    async handler({ cfg, engine, params, readBody, searchParams, send }) {
      const approvalId = decodeURIComponent(params["approvalId"]!);
      const action = params["action"];
      const body = await readBody();
      const scope = String(body["scope"] ?? searchParams.get("scope") ?? "once");
      const decision =
        action === "reject"
          ? "reject"
          : action === "approve" && scope === "always"
            ? "always"
            : action === "approve"
              ? "once"
              : action;
      if (!["once", "always", "reject"].includes(decision!)) {
        send(400, { error: "invalid_decision" });
        return;
      }
      const approvals = await listApprovalRecords(cfg);
      const approval = approvals.find((item) => matchesApprovalId(item, approvalId));
      if (!approval) {
        send(404, { error: "not_found" });
        return;
      }
      await engine.handleOwnerDecision({
        mode: decision as "once" | "always" | "reject",
        decidedBy: "owner-ui",
        target: { kind: "thread", threadKey: approval.threadKey },
      });
      await addApprovalAudit(cfg, approval, decision === "reject" ? "reject" : "approve", "owner-ui");
      send(200, { ok: true });
    },
  },

  // Audit
  {
    method: "GET",
    pattern: "/api/audit",
    async handler({ cfg, send }) {
      send(200, { items: await listAuditForUi(cfg) });
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers (moved from app.ts)
// ---------------------------------------------------------------------------

function validateId(value: string): string | null {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) return null;
  return value;
}

function extractContactParams(params: Record<string, string>): { source?: string; userId?: string } {
  const source = params["source"];
  const rest = params["**"];
  if (!source || !rest) return {};
  return { source, userId: rest };
}

function matchesApprovalId(record: { id?: string; requestId?: string; requestPath?: string }, id: string): boolean {
  return (
    record.id === id ||
    record.requestId === id ||
    record.requestPath === id ||
    path.basename(record.requestPath ?? "") === id
  );
}

function normalizeSkillBody(body: Record<string, unknown>): {
  name?: string;
  description?: string;
  permissions: string[];
  body: string;
} {
  return {
    name: typeof body["name"] === "string" ? body["name"] : undefined,
    description: typeof body["description"] === "string" ? body["description"] : undefined,
    permissions: normalizeList(body["permissions"]),
    body: typeof body["body"] === "string" ? body["body"] : "",
  };
}

function normalizeContactBody(body: Record<string, unknown>): {
  display?: string;
  username?: string;
  allowed_permissions?: string[];
  notes?: string;
} {
  return {
    display: typeof body["display"] === "string" ? body["display"] : undefined,
    username: typeof body["username"] === "string" ? body["username"] : undefined,
    allowed_permissions: normalizeList(body["allowed_permissions"]),
    notes: typeof body["notes"] === "string" ? body["notes"] : undefined,
  };
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return [];
}
