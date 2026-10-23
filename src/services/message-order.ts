export function isDiscordMessageBefore(messageId: string, referenceMessageId: string): boolean {
  if (!/^\d+$/.test(messageId) || !/^\d+$/.test(referenceMessageId)) {
    return false;
  }

  return BigInt(messageId) < BigInt(referenceMessageId);
}
