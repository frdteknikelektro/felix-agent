export type SourceName = "mattermost" | string;

export interface SourceSender {
  source: SourceName;
  id: string;
  username?: string;
  display?: string;
}

export interface UniversalAttachment {
  file_id: string;
  filename: string;
  content_type?: string;
  size_bytes?: number;
  local_path?: string;
  is_image?: boolean;
}

export interface UniversalEvent {
  source: SourceName;
  event_id: string;
  thread_key: string;
  received_at: string;
  visibility: "dm" | "channel";
  mentions_bot: boolean;
  sender: SourceSender;
  text: string;
  attachments: UniversalAttachment[];
  raw_path: string;
  source_thread: {
    channel_id?: string;
    root_id?: string;
    user_id?: string;
  };
}

export interface ThreadState {
  thread_key: string;
  source: SourceName;
  created_at: string;
  updated_at: string;
  managed_by_felix: boolean;
  source_thread: {
    channel_id?: string;
    root_id?: string;
    user_id?: string;
  };
  participants: string[];
}

export interface SessionQueueItem {
  received_at: string;
  event_file: string;
  source_event_id: string;
}

export interface SessionPermissionRequest {
  requested_at: string;
  skill_id: string;
  permissions: string[];
  reason: string;
  owner_message: string;
  owner_message_post_id?: string;
  owner_message_channel_id?: string;
  thread_key: string;
  requester: SourceSender;
  requester_event_file: string;
}

export interface SessionState {
  codex_session_id?: string;
  busy: boolean;
  queue: SessionQueueItem[];
  pending_permission?: SessionPermissionRequest | null;
  last_event_at?: string;
  last_turn_at?: string;
}

export interface SkillRecord {
  id: string;
  name?: string;
  description?: string;
  permissions: string[];
  path: string;
  body: string;
}

export interface ContactRecord {
  source: SourceName;
  user_id: string;
  display?: string;
  username?: string;
  allowed_permissions: string[];
  allowed_skills: string[];
  notes?: string;
}

export interface PermissionDecision {
  mode: "once" | "always" | "reject";
}
