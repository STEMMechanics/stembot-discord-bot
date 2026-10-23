/**
 * Detects short, natural requests for help in a minigame message.
 *
 * The caller still decides which game is active. Keeping this detector small
 * prevents ordinary answers containing words such as "help" from becoming
 * hint requests.
 */
export function isMinigameHintRequest(content: string): boolean {
  const normalized = content
    .normalize('NFKC')
    .replace(/<@!?\d+>/g, ' ')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  if (/^(?:a\s+)?(?:hint|hints|clue|clues|help|help\s+me)$/.test(normalized)) {
    return true;
  }

  if (/\b(?:hint|hints|clue|clues)\b/.test(normalized)) {
    return true;
  }

  if (
    /\b(?:stuck|help)\b/.test(normalized) &&
    /\b(?:can|could|please|need|want|give|another|any|some|me)\b/.test(normalized)
  ) {
    return true;
  }

  return /\b(?:what word|any ideas|what should i try)\b/.test(normalized);
}
