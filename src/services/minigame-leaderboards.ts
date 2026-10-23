export interface MinigameLeaderboardEntry {
  userId: string;
  score: number;
}

export interface MinigameLeaderboardProvider {
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

export function toMinigameLeaderboard(
  scores: Readonly<Record<string, number>>,
  limit: number,
): readonly MinigameLeaderboardEntry[] {
  return Object.entries(scores)
    .map(([userId, score]) => ({ userId, score }))
    .filter(
      (entry) => entry.userId.length > 0 && Number.isSafeInteger(entry.score) && entry.score > 0,
    )
    .sort((left, right) => right.score - left.score || left.userId.localeCompare(right.userId))
    .slice(0, Math.max(1, Math.min(25, Math.floor(limit))));
}

export function readMinigameScores(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const scores: Record<string, number> = {};
  for (const [userId, score] of Object.entries(value)) {
    if (
      userId.length > 0 &&
      typeof score === 'number' &&
      Number.isSafeInteger(score) &&
      score >= 0
    ) {
      scores[userId] = score;
    }
  }
  return scores;
}
