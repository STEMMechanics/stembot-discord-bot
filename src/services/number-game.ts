import { randomUUID } from 'node:crypto';

import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';

export interface NumberGameMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  referencedMessageId?: string;
  reply(content: string): Promise<void>;
}

export interface NumberGameChallengeStart {
  challengeId: string;
  content: string;
}

export interface NumberGameService {
  startChallenge(userId: string, channelId: string): Promise<NumberGameChallengeStart>;
  activateChallenge(challengeId: string, promptMessageId: string): Promise<void>;
  handleMessage(message: NumberGameMessage): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface NumberGameChallengeState {
  id: string;
  userId: string;
  channelId: string;
  promptMessageId: string;
  answer: number;
  startedAt: string;
}

interface NumberGameState {
  version: 1;
  active: Record<string, NumberGameChallengeState>;
  correctGuesses: Record<string, number>;
}

interface NumberGameServiceDependencies {
  state: StateStore<JsonState>;
  logger: AppLogger;
  random?: () => number;
  idFactory?: () => string;
}

const MIN_NUMBER = 1;
const MAX_NUMBER = 20;
const STATE_KEY = 'numberGame';
const PROMPT_CONTENT =
  '🎲 I’m thinking of a number between **1 and 20**. Reply to this message with your one guess!';

export class PersistentNumberGameService implements NumberGameService {
  private readonly random: () => number;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: NumberGameServiceDependencies) {
    this.random = dependencies.random ?? Math.random;
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async startChallenge(
    userId: string,
    channelId: string,
  ): Promise<NumberGameChallengeStart> {
    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readNumberGameState(rootState[STATE_KEY]);
      const challenge: NumberGameChallengeState = {
        id: this.idFactory(),
        userId,
        channelId,
        promptMessageId: '',
        answer: randomNumber(this.random),
        startedAt: new Date().toISOString(),
      };
      state.active[numberGamePlayerKey(userId, channelId)] = challenge;
      writeNumberGameState(rootState, state);
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        { channelId, userId, challengeId: challenge.id },
        'Number game challenge created',
      );
      return { challengeId: challenge.id, content: PROMPT_CONTENT };
    });
  }

  public async activateChallenge(challengeId: string, promptMessageId: string): Promise<void> {
    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readNumberGameState(rootState[STATE_KEY]);
      const challenge = Object.values(state.active).find(({ id }) => id === challengeId);
      if (!challenge) {
        this.dependencies.logger.debug(
          { challengeId, promptMessageId },
          'Number game challenge was replaced before its prompt could be activated',
        );
        return;
      }

      challenge.promptMessageId = promptMessageId;
      writeNumberGameState(rootState, state);
      await this.dependencies.state.save(rootState);
    });
  }

  public async handleMessage(message: NumberGameMessage): Promise<void> {
    if (message.authorIsBot || !message.referencedMessageId) {
      return;
    }

    await this.enqueue(() => this.processMessage(message));
  }

  private async processMessage(message: NumberGameMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readNumberGameState(rootState[STATE_KEY]);
    const challenge = state.active[numberGamePlayerKey(message.authorId, message.channelId)];
    if (!challenge || challenge.promptMessageId !== message.referencedMessageId) {
      return;
    }

    delete state.active[numberGamePlayerKey(message.authorId, message.channelId)];
    const guess = readNumberGuess(message.content);
    const correct = guess === challenge.answer;
    if (correct) {
      state.correctGuesses[message.authorId] = (state.correctGuesses[message.authorId] ?? 0) + 1;
    }
    writeNumberGameState(rootState, state);
    await this.dependencies.state.save(rootState);

    const response = correct
      ? `🎉 Correct! I was thinking of **${challenge.answer}**.`
      : `❌ Not quite — I was thinking of **${challenge.answer}**. That was your one attempt.`;
    await this.replySafely(message, response);
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        promptMessageId: challenge.promptMessageId,
        userId: message.authorId,
        correct,
      },
      'Number game challenge completed',
    );
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readNumberGameState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.correctGuesses, limit);
    });
  }

  private async replySafely(message: NumberGameMessage, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'Number game result could not be sent',
      );
    }
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.eventQueue.catch(() => undefined).then(work);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }
}

export function createNumberGameService(
  dependencies: NumberGameServiceDependencies,
): NumberGameService {
  return new PersistentNumberGameService(dependencies);
}

function randomNumber(random: () => number): number {
  const value = random();
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0;
  return Math.floor(normalized * (MAX_NUMBER - MIN_NUMBER + 1)) + MIN_NUMBER;
}

function readNumberGuess(content: string): number | undefined {
  const normalized = content.trim();
  if (!/^[+-]?\d+$/.test(normalized)) {
    return undefined;
  }

  const guess = Number(normalized);
  return Number.isSafeInteger(guess) && guess >= MIN_NUMBER && guess <= MAX_NUMBER
    ? guess
    : undefined;
}

function numberGamePlayerKey(userId: string, channelId: string): string {
  return `${channelId}:${userId}`;
}

function createInitialNumberGameState(): NumberGameState {
  return { version: 1, active: {}, correctGuesses: {} };
}

function readNumberGameState(value: unknown): NumberGameState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.active)) {
    return createInitialNumberGameState();
  }

  const active: Record<string, NumberGameChallengeState> = {};
  for (const [key, candidate] of Object.entries(value.active)) {
    if (isNumberGameChallenge(candidate)) {
      active[key] = candidate;
    }
  }
  return {
    version: 1,
    active,
    correctGuesses: readMinigameScores(value.correctGuesses),
  };
}

function isNumberGameChallenge(value: unknown): value is NumberGameChallengeState {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.userId === 'string' &&
    value.userId.length > 0 &&
    typeof value.channelId === 'string' &&
    value.channelId.length > 0 &&
    typeof value.promptMessageId === 'string' &&
    typeof value.answer === 'number' &&
    Number.isInteger(value.answer) &&
    value.answer >= MIN_NUMBER &&
    value.answer <= MAX_NUMBER &&
    typeof value.startedAt === 'string'
  );
}

function writeNumberGameState(rootState: JsonState, state: NumberGameState): void {
  rootState[STATE_KEY] = state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
