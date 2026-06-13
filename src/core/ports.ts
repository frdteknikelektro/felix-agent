import type { ContactRecord, SkillRecord, SourceMessageAnchor, UniversalAttachment, UniversalEvent } from "../types.js";
import type { ThreadHandle } from "../slices/sessions/index.js";

// ─── Source port ──────────────────────────────────────────────────────────────

export interface SourceAdapter {
  source: string;
  /** Bot's user ID on this source, used for self-message filtering. */
  botUserId?: string;
  /** Owner's user ID on this source, used for permission-request DMs. */
  ownerUserId?: string;
  getThreadLink(threadKey: string): Promise<string | undefined>;
  getTurnContext(input: { event: UniversalEvent }): Promise<SourceTurnContext>;
  updateEventStatus(input: { event: UniversalEvent; status: SourceEventStatus }): Promise<void>;
  sendTyping(input: { event: UniversalEvent }): Promise<void>;
  sendThreadReply(input: { event: UniversalEvent; text: string }): Promise<void>;
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
}

export type SourceEventStatus = "processing" | "replied" | "permission_required";

export interface SourceTurnContext {
  behaviorInstructions: string[];
  owner?: {
    userId?: string;
    display: string;
  };
}

// ─── Harness port ─────────────────────────────────────────────────────────────

export interface ParsedAgentOutput {
  kind: "reply" | "permission_required" | "no_skill" | "unknown";
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
}

export interface TurnResult {
  sessionId: string;
  exitCode: number;
  /** true when exitCode === 0 and the output contains a renderable response */
  success: boolean;
  parsed: ParsedAgentOutput;
  logPath: string;
}

export interface DecisionNotificationInput {
  thread: ThreadHandle;
  mode: "once" | "always" | "reject";
  skillId: string;
  reason: string;
  ownerDisplay?: string;
}

export interface Harness {
  run(input: TurnInput): Promise<TurnResult>;
  generateDecisionNotification?(input: DecisionNotificationInput): Promise<string>;
}
