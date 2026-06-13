import path from "node:path";
import { safeFileName } from "../../lib/fs.js";
import { parseFrontmatter } from "../../lib/markdown.js";
import type {
  SessionPermissionRequest,
  SourceName,
  SourceSender,
  SourceThreadRef,
  UniversalAttachment,
  UniversalEvent,
} from "../../types.js";

/**
 * The single home for the thread event-kind union. Every event file Felix
 * writes carries a `type` discriminant; this module owns what each kind looks
 * like on disk (frontmatter, body, transcript lines, file-name slug) and how to
 * read one back. Writers call {@link buildEventFile}; readers call
 * {@link parseEventFile} and then narrow on the returned `kind`. Nothing else
 * encodes the union — add a field in one place, not four.
 */
export type EventKind = "source_event" | "felix_reply" | "owner_permission" | "permission_request";

export interface OwnerPermissionDetails {
  owner_user_id?: string;
  request_id?: string;
  skill_id: string;
  permissions: string[];
  scope: "once" | "always";
  source_thread_ref?: SourceThreadRef;
  reason?: string;
}

export type EventFileInput =
  | { kind: "source_event"; event: UniversalEvent }
  | { kind: "felix_reply"; at: string; text: string; harnessSessionId?: string }
  | {
      kind: "owner_permission";
      at: string;
      source: SourceName;
      threadKey: string;
      decision: "approved" | "rejected";
      details: OwnerPermissionDetails;
    }
  | { kind: "permission_request"; request: SessionPermissionRequest };

export interface EventFileSpec {
  at: string;
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
  transcriptLines: string[];
  compactTranscript?: boolean;
}

export function buildEventFile(input: EventFileInput): EventFileSpec {
  switch (input.kind) {
    case "source_event":
      return buildSourceEvent(input.event);
    case "felix_reply":
      return buildFelixReply(input.at, input.text, input.harnessSessionId);
    case "owner_permission":
      return buildOwnerPermission(input.at, input.source, input.threadKey, input.decision, input.details);
    case "permission_request":
      return buildPermissionRequest(input.request);
  }
}

function buildSourceEvent(event: UniversalEvent): EventFileSpec {
  const attachmentLines = event.attachments.length
    ? ["", "Attachments:", ...event.attachments.map(renderAttachmentLine)]
    : [];
  return {
    at: event.received_at,
    slug: `${safeFileName(event.source)}_${safeFileName(event.event_id)}`,
    frontmatter: {
      type: "source_event",
      source: event.source,
      event_id: event.event_id,
      thread_key: event.thread_key,
      received_at: event.received_at,
      visibility: event.visibility,
      mentions_bot: event.mentions_bot,
      sender: event.sender,
      source_thread_ref: event.source_thread_ref,
      attachments: event.attachments,
    },
    body: `${event.text.trim()}\n${attachmentLines.join("\n")}\n`,
    transcriptLines: [
      `### [${event.received_at}] ${event.source}:${event.sender.id}`,
      event.text.trim(),
      ...attachmentLines,
    ],
  };
}

function renderAttachmentLine(attachment: UniversalAttachment): string {
  const label = attachment.local_path ?? attachment.filename;
  if (attachment.status === "rejected") {
    return `- ${label} (rejected: ${attachment.rejected_reason ?? "not available"})`;
  }
  const size = typeof attachment.size_bytes === "number" ? `, ${attachment.size_bytes} bytes` : "";
  const type = attachment.content_type ? `, ${attachment.content_type}` : "";
  return `- ${label}${type}${size}`;
}

function buildFelixReply(at: string, text: string, harnessSessionId?: string): EventFileSpec {
  return {
    at,
    slug: "felix_reply",
    frontmatter: {
      type: "felix_reply",
      at,
      harness_session_id: harnessSessionId,
    },
    body: `${text.trim()}\n`,
    transcriptLines: [`### [${at}] felix`, text.trim()],
  };
}

function buildOwnerPermission(
  at: string,
  source: SourceName,
  threadKey: string,
  decision: "approved" | "rejected",
  details: OwnerPermissionDetails,
): EventFileSpec {
  return {
    at,
    slug: `owner_permission_${decision}`,
    frontmatter: {
      type: "owner_permission",
      source,
      thread_key: threadKey,
      decision,
      approved_at: at,
      request_id: details.request_id,
      ...details,
    },
    body:
      [
        `${decision === "approved" ? "Approved" : "Rejected"} permission for ${details.skill_id}.`,
        `Scope: ${details.scope}`,
        details.reason ? `Reason: ${details.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    transcriptLines: [
      `### [${at}] owner_permission:${decision}`,
      `Skill: ${details.skill_id}`,
      `Scope: ${details.scope}`,
      `Permissions: ${details.permissions.join(", ")}`,
      details.reason ? `Reason: ${details.reason}` : "",
    ],
    compactTranscript: true,
  };
}

function buildPermissionRequest(request: SessionPermissionRequest): EventFileSpec {
  return {
    at: request.requested_at,
    slug: "permission_request",
    frontmatter: {
      type: "permission_request",
      request_id: request.request_id,
      requested_at: request.requested_at,
      skill_id: request.skill_id,
      permissions: request.permissions,
      reason: request.reason,
      owner_message: request.owner_message,
      owner_message_anchor: request.owner_message_anchor,
    },
    body: [
      `Permission required for ${request.skill_id}.`,
      `Permissions: ${request.permissions.join(", ") || "(none)"}`,
      `Reason: ${request.reason}`,
      `Owner message: ${request.owner_message}`,
      request.owner_message_anchor?.message_id ? `Owner message: ${request.owner_message_anchor.message_id}` : "",
    ].join("\n"),
    transcriptLines: [
      `### [${request.requested_at}] permission_request:${request.skill_id}`,
      `Permissions: ${request.permissions.join(", ") || "(none)"}`,
      `Reason: ${request.reason}`,
    ],
    compactTranscript: true,
  };
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

interface SourceEventFrontmatter {
  type?: string;
  source?: SourceName;
  event_id?: string;
  thread_key?: string;
  received_at?: string;
  visibility?: "dm" | "channel";
  mentions_bot?: boolean;
  sender?: SourceSender;
  attachments?: UniversalAttachment[];
  source_thread_ref?: UniversalEvent["source_thread_ref"];
}

interface FelixReplyFrontmatter {
  type?: string;
  at?: string;
  harness_session_id?: string;
}

interface OwnerPermissionFrontmatter {
  type?: string;
  source?: SourceName;
  thread_key?: string;
  decision?: "approved" | "rejected";
  approved_at?: string;
  owner_user_id?: string;
  request_id?: string;
  skill_id?: string;
  permissions?: string[];
  scope?: "once" | "always";
  reason?: string;
  source_thread_ref?: UniversalEvent["source_thread_ref"];
}

interface PermissionRequestFrontmatter {
  type?: string;
  request_id?: string;
  requested_at?: string;
  skill_id?: string;
  permissions?: string[];
  reason?: string;
  owner_message?: string;
  owner_message_anchor?: SessionPermissionRequest["owner_message_anchor"];
}

export type ParsedEvent =
  | { kind: "source_event"; frontmatter: SourceEventFrontmatter; body: string }
  | { kind: "felix_reply"; frontmatter: FelixReplyFrontmatter; body: string }
  | { kind: "owner_permission"; frontmatter: OwnerPermissionFrontmatter; body: string }
  | { kind: "permission_request"; frontmatter: PermissionRequestFrontmatter; body: string }
  | { kind: "unknown"; frontmatter: Record<string, unknown>; body: string };

export function parseEventFile(raw: string): ParsedEvent {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
  const type = typeof frontmatter.type === "string" ? frontmatter.type : undefined;
  switch (type) {
    case "source_event":
      return { kind: "source_event", frontmatter: frontmatter as SourceEventFrontmatter, body };
    case "felix_reply":
      return { kind: "felix_reply", frontmatter: frontmatter as FelixReplyFrontmatter, body };
    case "owner_permission":
      return { kind: "owner_permission", frontmatter: frontmatter as OwnerPermissionFrontmatter, body };
    case "permission_request":
      return { kind: "permission_request", frontmatter: frontmatter as PermissionRequestFrontmatter, body };
    default:
      return { kind: "unknown", frontmatter, body };
  }
}

export function toUniversalEvent(parsed: ParsedEvent, rawPath: string): UniversalEvent {
  if (parsed.kind === "owner_permission") {
    const fm = parsed.frontmatter;
    return {
      source: fm.source ?? "mattermost",
      event_id: fm.request_id ?? path.basename(rawPath),
      thread_key: fm.thread_key ?? "unknown",
      received_at: fm.approved_at ?? new Date().toISOString(),
      visibility: "dm",
      mentions_bot: true,
      sender: {
        source: fm.source ?? "mattermost",
        id: fm.owner_user_id ?? "owner",
        display: fm.owner_user_id ?? "owner",
      },
      text: parsed.body.trim(),
      attachments: [],
      raw_path: rawPath,
      source_thread_ref: fm.source_thread_ref ?? { source: fm.source ?? "mattermost" },
    };
  }
  const fm = parsed.frontmatter as SourceEventFrontmatter;
  return {
    source: fm.source ?? "mattermost",
    event_id: fm.event_id ?? path.basename(rawPath),
    thread_key: fm.thread_key ?? "unknown",
    received_at: fm.received_at ?? new Date().toISOString(),
    visibility: fm.visibility ?? "channel",
    mentions_bot: Boolean(fm.mentions_bot),
    sender: fm.sender ?? { source: "mattermost", id: "unknown" },
    text: parsed.body.trim(),
    attachments: fm.attachments ?? [],
    raw_path: rawPath,
    source_thread_ref: fm.source_thread_ref ?? { source: fm.source ?? "mattermost" },
  };
}

export function eventAt(parsed: ParsedEvent): string | undefined {
  switch (parsed.kind) {
    case "source_event":
      return trimmed(parsed.frontmatter.received_at);
    case "felix_reply":
      return trimmed(parsed.frontmatter.at);
    case "owner_permission":
      return trimmed(parsed.frontmatter.approved_at);
    case "permission_request":
      return trimmed(parsed.frontmatter.requested_at);
    case "unknown":
      return undefined;
  }
}

export function historyTitle(parsed: ParsedEvent, raw: string): string {
  switch (parsed.kind) {
    case "source_event":
      return `Source event: ${senderLabel(parsed.frontmatter.sender)}`;
    case "felix_reply":
      return "Felix reply";
    case "permission_request":
      return `Permission request: ${parsed.frontmatter.skill_id ?? "(unknown)"}`;
    case "owner_permission":
      return `${parsed.frontmatter.decision === "rejected" ? "Rejected" : "Approved"} permission`;
    case "unknown":
      return truncate(raw.replace(/\s+/g, " "), 80);
  }
}

function senderLabel(sender: SourceSender | undefined): string {
  return trimmed(sender?.display) ?? trimmed(sender?.id) ?? "unknown";
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
