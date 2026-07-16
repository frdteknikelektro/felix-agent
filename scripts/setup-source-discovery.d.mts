export interface TelegramOwnerClaim {
  userId: string;
}

export interface TelegramOwnerClaimOptions {
  botToken: string;
  claimCode: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function claimTelegramOwner(options: TelegramOwnerClaimOptions): Promise<TelegramOwnerClaim>;
