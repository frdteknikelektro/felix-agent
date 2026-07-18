import type { ContactRecord, SkillRecord, SourceMessageAnchor, UniversalAttachment, UniversalEvent } from "../types.js";
import type { ThreadHandle } from "../slices/sessions/index.js";
import type { PlatformIdentity } from "./platform-identity.js";

// ─── Source port ──────────────────────────────────────────────────────────────

export interface SourceAdapter {
  source: string;
  /** Runtime bot identity, discovered from the platform or paired account. */
  readonly botIdentity?: PlatformIdentity;
  /** Human-facing owner display resolved by the adapter when available. */
  readonly ownerDisplay?: string;
  /** Bot's user ID on this source, used for self-message filtering. */
  botUserId?: string;
  /** Owner's user ID on this source, used for permission-request DMs. */
  ownerUserId?: string;
  getThreadLink(threadKey: string): Promise<string | undefined>;
  getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext>;
  updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void>;
  sendTyping(input: { event: UniversalEvent }): Promise<void>;
  sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void>;
  editUserMessage?(input: { anchor: SourceMessageAnchor; text: string }): Promise<void>;
  sendUserMessage(input: {
    userId: string;
    text: string;
  }): Promise<SourceMessageAnchor | null>;
  downloadAttachment(input: {
    event: UniversalEvent;
    attachment: UniversalAttachment;
    destinationDir: string;
    maxBytes: number;
  }): Promise<UniversalAttachment>;
  formatOwnerNotification(input: {
    skillId: string;
    permissions: string[];
    reason: string;
    requesterName: string;
    requesterId: string;
    threadLink?: string;
    status?: "pending" | "approved" | "rejected";
    decisionMode?: "once" | "always" | "reject";
    decidedAt?: string;
  }): Promise<string>;
}

export type SourceEventStatus = "processing" | "replied" | "permission_required";

export interface SourceTurnContext {
  behaviorInstructions: string[];
  /** Whether the current sender is the owner of this source. */
  isOwner?: boolean;
  /** Owner information for this source. */
  owner?: {
    /** Owner's display name. */
    displayName?: string;
    /** Owner's username on this source. */
    username?: string;
    /** Owner's user ID on this source. */
    userId?: string;
  };
}

// ─── Harness port ─────────────────────────────────────────────────────────────

export interface ParsedAgentOutput {
  kind: "reply" | "permission_required" | "no_skill" | "unknown" | "format_error";
  text: string;
  skillId?: string;
  permissions?: string[];
  reason?: string;
  ownerMessage?: string;
}

export interface PermissionRequiredOutput {
  kind: "permission_required";
  text: string;
  skillId?: string;
  permissions: string[];
  reason?: string;
  ownerMessage?: string;
}

export interface TurnInput {
  thread: ThreadHandle;
  event: UniversalEvent;
  eventFile: string;
  contact: ContactRecord;
  skills: SkillRecord[];
  sourceContext: SourceTurnContext;
  resumed: boolean;
  precedingEvents?: { event: UniversalEvent; eventFile: string }[];
  promptOverride?: string;
  modelOverride?: string;
  signal?: AbortSignal;
}

/** Normalized per-turn token usage, extracted from the harness CLI's JSON stream. */
export interface TurnUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** input + output + cache_write (cache_read excluded — it is discounted reuse). */
  total: number;
  model: string | null;
}

export interface TurnResult {
  sessionId: string;
  exitCode: number;
  /** true when exitCode === 0 and the output contains a renderable response */
  success: boolean;
  parsed: ParsedAgentOutput;
  logPath: string;
  /** Token usage for this turn, when the harness emitted parseable usage data. */
  usage?: TurnUsage | null;
  /**
   * True when `usage` is session-cumulative rather than per-turn (codex reports a
   * running total across resumed turns). The engine deltas cumulative usage against
   * the thread's last-seen total before recording. Unset/false ⇒ already per-turn.
   */
  usageCumulative?: boolean;
}

export interface DecisionNotificationInput {
  thread: ThreadHandle;
  mode: "once" | "always" | "reject";
  skillId: string;
  reason: string;
  ownerDisplay?: string;
  agentName?: string;
}

export interface CompactResult {
  success: boolean;
  /** New session ID created by the compact operation, if any. */
  sessionId?: string;
}

export interface Harness {
  run(input: TurnInput): Promise<TurnResult>;
  generateDecisionNotification?(input: DecisionNotificationInput): Promise<string>;
  /** Trigger compaction for the given session to reduce context size. */
  compact?(sessionId: string, threadDir?: string): Promise<CompactResult>;
}
