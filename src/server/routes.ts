import type http from "node:http";
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
  listAuditForUi,
  addSkillAudit,
  addContactAudit,
  addApprovalAudit,
  listDatabaseConnections,
  loadDatabaseConnection,
  createDatabaseConnection,
  updateDatabaseConnection,
  deleteDatabaseConnection,
  addDatabaseAudit,
} from "../owner-data.js";
import { parseUsageWindow, usageView } from "../slices/usage/index.js";
import { listApprovalRecords, ownerDecisionFromAction } from "../slices/approvals/index.js";
import {
  ContactEditorError,
  createContactFromEditor,
  listContacts,
  loadContactForEditor,
  updateContactFromEditor,
} from "../slices/contacts/index.js";

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
      const threadKey = params["threadKey"];
      if (!threadKey) { send(400, { error: "missing_thread_key" }); return; }
      const detail = await loadSessionDetail(cfg, threadKey);
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
      const threadKey = params["threadKey"];
      if (!threadKey) { send(400, { error: "missing_thread_key" }); return; }
      const messages = await loadChatTimeline(cfg, threadKey);
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
      const skillId = validateId(params["skillId"] ?? "");
      if (!skillId) { send(400, { error: "invalid_skill_id" }); return; }
      const skill = await loadSkillForUi(cfg, skillId);
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
      const skillId = validateId(params["skillId"] ?? "");
      if (!skillId) { send(400, { error: "invalid_skill_id" }); return; }
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
      const skillId = validateId(params["skillId"] ?? "");
      if (!skillId) { send(400, { error: "invalid_skill_id" }); return; }
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
      send(200, { items: await listContacts(cfg) });
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
      const contact = await loadContactForEditor(cfg, source, userId);
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
      const body = await readBody();
      try {
        const saved = await updateContactFromEditor(cfg, source, userId, body);
        await addContactAudit(cfg, source, userId, "update", `Updated contact ${source}:${userId}`, {
          permissions: saved.allowed_permissions,
        });
        send(200, saved);
      } catch (error) {
        if (isContactEditorError(error, "contact_missing")) {
          send(404, { error: "not_found" });
          return;
        }
        throw error;
      }
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
        const saved = await createContactFromEditor(cfg, source, userId, body);
        await addContactAudit(cfg, source, userId, "create", `Created contact ${source}:${userId}`, {
          permissions: saved.allowed_permissions,
        });
        send(201, saved);
      } catch (error) {
        if (isContactEditorError(error, "contact_exists")) {
          send(409, { error: "contact_exists" });
          return;
        }
        throw error;
      }
    },
  },

  // Database connections
  {
    method: "GET",
    pattern: "/api/databases",
    async handler({ cfg, send }) {
      send(200, { items: await listDatabaseConnections(cfg) });
    },
  },
  {
    method: "GET",
    pattern: "/api/databases/:alias",
    async handler({ cfg, params, send }) {
      const alias = validateId(params["alias"] ?? "");
      if (!alias) { send(400, { error: "invalid_alias" }); return; }
      const conn = await loadDatabaseConnection(cfg, alias);
      if (!conn) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, conn);
    },
  },
  {
    method: "POST",
    pattern: "/api/databases",
    async handler({ cfg, readBody, send }) {
      const body = await readBody();
      const alias = validateId(String(body["alias"] ?? ""));
      if (!alias) {
        send(400, { error: "invalid_alias" });
        return;
      }
      try {
        const saved = await createDatabaseConnection(cfg, alias, body);
        await addDatabaseAudit(cfg, alias, "create", `Created connection ${alias}`);
        send(201, saved);
      } catch (error) {
        if (error instanceof Error && error.message === "connection_exists") {
          send(409, { error: "connection_exists" });
          return;
        }
        throw error;
      }
    },
  },
  {
    method: "PUT",
    pattern: "/api/databases/:alias",
    async handler({ cfg, params, readBody, send }) {
      const alias = validateId(params["alias"] ?? "");
      if (!alias) { send(400, { error: "invalid_alias" }); return; }
      const body = await readBody();
      try {
        const saved = await updateDatabaseConnection(cfg, alias, body);
        await addDatabaseAudit(cfg, alias, "update", `Updated connection ${alias}`);
        send(200, saved);
      } catch (error) {
        if (error instanceof Error && error.message === "connection_missing") {
          send(404, { error: "not_found" });
          return;
        }
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/databases/:alias",
    async handler({ cfg, params, send }) {
      const alias = validateId(params["alias"] ?? "");
      if (!alias) { send(400, { error: "invalid_alias" }); return; }
      try {
        await deleteDatabaseConnection(cfg, alias);
        await addDatabaseAudit(cfg, alias, "delete", `Deleted connection ${alias}`);
        send(200, { ok: true });
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          send(404, { error: "not_found" });
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
      const approvalId = decodeURIComponent(params["approvalId"] ?? "");
      if (!approvalId) { send(400, { error: "missing_approval_id" }); return; }
      const action = params["action"] ?? "";
      const body = await readBody();
      const scope = String(body["scope"] ?? searchParams.get("scope") ?? "once");
      const mode = ownerDecisionFromAction(action, scope);
      if (!mode) {
        send(400, { error: "invalid_decision" });
        return;
      }
      const approvals = await listApprovalRecords(cfg);
      const approval = approvals.find((item) => matchesApprovalId(item, approvalId));
      if (!approval) {
        send(404, { error: "not_found" });
        return;
      }
      const applied = await engine.handleOwnerDecision({
        mode,
        decidedBy: "owner-ui",
        target: { kind: "approval", approvalId: approval.id },
      });
      if (!applied) {
        send(409, { error: "already_decided" });
        return;
      }
      await addApprovalAudit(cfg, approval, mode === "reject" ? "reject" : "approve", "owner-ui");
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

  // Usage
  {
    method: "GET",
    pattern: "/api/usage",
    async handler({ cfg, searchParams, send }) {
      const window = parseUsageWindow(searchParams.get("window")) ?? "today";
      send(200, await usageView(cfg, window));
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

function matchesApprovalId(record: { id?: string; requestId?: string }, id: string): boolean {
  return record.id === id || record.requestId === id;
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

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return [];
}

function isContactEditorError(error: unknown, code: string): boolean {
  return error instanceof ContactEditorError && error.code === code;
}
