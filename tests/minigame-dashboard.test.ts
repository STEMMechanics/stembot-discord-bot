import { describe, expect, it } from 'vitest';

import { buildMinigameInfoEmbed } from '../src/discord/client.js';
import type { CountingChainGameStatus } from '../src/services/counting-chain.js';

const status: CountingChainGameStatus = {
  expectedNumber: 8,
  lastAuthorId: 'counting-user',
  lastMessageId: 'counting-message',
  updatedAt: '2026-10-23T00:00:00.000Z',
  highScore: 7,
  highScoreAt: '2026-10-23T00:00:00.000Z',
  lastRound: 5,
  lastRoundAt: '2026-10-23T00:00:00.000Z',
  lastRoundReason: 'wrong-number',
};

describe('STEM minigame dashboard', () => {
  it('renders an independent top-three record section for each game', () => {
    const embed = buildMinigameInfoEmbed(status, 'Australia/Brisbane', {
      counting: [{ userId: 'counting-user', score: 7 }],
      quiz: [{ userId: 'quiz-user', score: 12 }],
      scramble: [{ userId: 'scramble-user', score: 5 }],
      wordChain: [{ userId: 'word-user', score: 6 }],
      wordReveal: [{ userId: 'reveal-user', score: 4 }],
      codeFix: [{ userId: 'code-user', score: 3 }],
    });

    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Countain Chain · highest number',
          value: expect.stringContaining('<@counting-user> · **7** highest number reached'),
        }),
        expect.objectContaining({
          name: 'Trivia · correct answers',
          value: expect.stringContaining('<@quiz-user> · **12** correct answers'),
        }),
        expect.objectContaining({
          name: 'Word Scramble · solved rounds',
          value: expect.stringContaining('<@scramble-user> · **5** solved rounds'),
        }),
        expect.objectContaining({
          name: 'Word chain · best round streak',
          value: expect.stringContaining('<@word-user> · **6** correct guesses in one round'),
        }),
        expect.objectContaining({
          name: 'Word Reveal · solved rounds',
          value: expect.stringContaining('<@reveal-user> · **4** solved rounds'),
        }),
        expect.objectContaining({
          name: 'Code Fix · correct fixes',
          value: expect.stringContaining('<@code-user> · **3** correct fixes'),
        }),
      ]),
    );
    expect(embed.fields?.some((field) => field.name === 'Minigame leaderboard')).toBe(false);
    expect(
      embed.fields?.filter((field) => field.name === '\u200b' && field.value === '\u200b'),
    ).toHaveLength(5);
  });
});
