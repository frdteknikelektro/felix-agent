/**
 * Slack mention grammar — `<@userId>` format.
 * Simple helper that produces the mention token for a given user ID.
 */
export function slackMentionToken(userId?: string): string | undefined {
  return userId ? `<@${userId}>` : undefined;
}
