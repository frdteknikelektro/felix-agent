/** Runtime identity discovered from an authenticated platform account. */
export interface PlatformIdentity {
  userId: string;
  username?: string;
  displayName?: string;
  /** How the identity was obtained. */
  source: "api" | "paired-account" | "legacy";
  /** Whether the platform identity was obtained during this process lifetime. */
  discovered: boolean;
}

export function preferDiscoveredIdentity(
  discovered: PlatformIdentity | undefined,
  legacyUserId: string | undefined,
  legacyUsername?: string,
  legacyDisplayName?: string,
): PlatformIdentity | undefined {
  if (discovered?.userId) return discovered;
  if (!legacyUserId) return undefined;
  return {
    userId: legacyUserId,
    username: legacyUsername,
    displayName: legacyDisplayName,
    source: "legacy",
    discovered: false,
  };
}
