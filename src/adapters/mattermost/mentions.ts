/**
 * Mattermost mention grammar — the single source for how a bot name becomes an
 * `@mention` token. Both the matcher (`isMentioned` in index.ts) and the
 * turn prompt (`buildTurnPrompt` in adapters/codex/index.ts) build tokens from
 * here, so the instruction Felix is given can never drift from what the adapter
 * matches.
 */
export function normalizeMattermostName(value?: string): string | undefined {
  const normalized = value?.trim().replace(/^@+/, "");
  return normalized ? normalized : undefined;
}

export function mattermostMentionToken(value?: string): string | undefined {
  const normalized = normalizeMattermostName(value);
  return normalized ? `@${normalized}` : undefined;
}

export function mattermostMentionTokens(username?: string, displayName?: string): string[] {
  const tokens = [mattermostMentionToken(username), mattermostMentionToken(displayName)].filter(
    Boolean,
  ) as string[];
  return Array.from(new Set(tokens));
}
