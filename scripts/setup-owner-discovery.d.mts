export type SetupOwnerSource = "mattermost" | "discord" | "slack" | "whatsapp" | "telegram";
export type SetupOwnerMethod = "preserved" | "lookup" | "claim" | "phone" | "manual";

export interface SetupOwnerResult {
  userId: string;
  method: SetupOwnerMethod;
}

export interface SetupOwnerPrompts {
  input(options: {
    message: string;
    validate?(value: string): true | string;
  }): Promise<string>;
  select(options: {
    message: string;
    choices: Array<{ value: string; name: string }>;
    default?: string;
  }): Promise<string>;
  showClaim(input: {
    source: "discord" | "slack" | "telegram";
    claimCode: string;
  }): Promise<void> | void;
  showConfirmation?(input: {
    source: "mattermost";
  }): Promise<void> | void;
  confirmExisting?(input: { source: SetupOwnerSource }): Promise<boolean>;
}

export interface SetupOwnerDependencies {
  fetchImpl?: typeof fetch;
  randomBytes?(size: number): Uint8Array | Promise<Uint8Array>;
  createDiscordClient?(options: {
    intents: ["DirectMessages"];
    partials: ["Channel"];
  }): Promise<unknown> | unknown;
  createSlackApp?(options: {
    token: string;
    appToken: string;
    socketMode: true;
  }): Promise<unknown> | unknown;
}

export interface ResolveSetupOwnerOptions {
  source: SetupOwnerSource;
  credentials: Record<string, string | undefined>;
  existingOwnerId?: string;
  timeoutMs?: number;
  prompts: SetupOwnerPrompts;
  dependencies?: SetupOwnerDependencies;
}

export function resolveSetupOwner(options: ResolveSetupOwnerOptions): Promise<SetupOwnerResult>;
