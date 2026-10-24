import { randomUUID } from 'node:crypto';

import type {
  CodeFixAnswerResult,
  CodeFixChallenge,
  CodeFixEngine,
} from '../integrations/openai-code-fix.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';
import { isDiscordMessageBefore } from './message-order.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';
import type { UserLevelService } from './user-levels.js';

export interface StemCodeFixConfig {
  enabled: boolean;
  channelId?: string;
  retryIntervalMs: number;
  topic: string;
  targetAgeMin: number;
  targetAgeMax: number;
  maxWrongAnswers: number;
  idleTimeoutMs?: number;
}

export interface StemCodeFixMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  react(emoji: string): Promise<void>;
}

export interface StemCodeFixPublisher {
  send(channelId: string, content: string): Promise<string>;
}

export interface StemCodeFixService {
  initialize(): Promise<void>;
  ensureChallenge(): Promise<void>;
  checkInactivity(): Promise<void>;
  resetChallenge(): Promise<string | undefined>;
  handleMessage(message: StemCodeFixMessage): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface StemCodeFixChallengeState extends CodeFixChallenge {
  id: string;
  messageId: string;
  challengeNumber: number;
  wrongAttempts: number;
  askedAt: string;
}

interface StemCodeFixChallengeHistory {
  title: string;
  answer: string;
}

interface StemCodeFixState {
  version: 1;
  nextChallengeNumber: number;
  challenge: StemCodeFixChallengeState | null;
  correctFixes: Record<string, number>;
  recentChallenges: StemCodeFixChallengeHistory[];
  processedMessageIds: string[];
}

interface StemCodeFixServiceDependencies {
  config: StemCodeFixConfig;
  engine: CodeFixEngine;
  publisher: StemCodeFixPublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
  clock?: () => Date;
  idFactory?: () => string;
}

const STATE_KEY = 'stemCodeFix';
const PASS_REACTION = '✅';
const WRONG_REACTION = '❌';
const UNCLEAR_REACTION = '🤔';
const EVALUATION_FAILURE_REACTION = '⚠️';
const MAX_RECENT_CHALLENGES = 20;
const MAX_PROCESSED_MESSAGE_IDS = 500;
const MAX_GENERATION_ATTEMPTS = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 259200000;

export class PersistentStemCodeFixService implements StemCodeFixService {
  private readonly currentTime: () => Date;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: StemCodeFixServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async initialize(): Promise<void> {
    await this.ensureChallenge();
  }

  public async ensureChallenge(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemCodeFixState(rootState[STATE_KEY]);
      if (state.challenge) {
        return;
      }

      await this.publishNextChallenge(rootState, state);
    });
  }

  public async checkInactivity(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemCodeFixState(rootState[STATE_KEY]);
      const challenge = state.challenge;
      if (!challenge) {
        return;
      }

      const askedAt = Date.parse(challenge.askedAt);
      const idleTimeoutMs = this.dependencies.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      if (!Number.isFinite(askedAt) || this.currentTime().getTime() - askedAt < idleTimeoutMs) {
        return;
      }

      state.challenge = null;
      writeStemCodeFixState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.publishNextChallenge(
        rootState,
        state,
        `⏰ This code bug has gone quiet for too long. The fix was: **${challenge.answer}**.\n${challenge.explanation}`,
      );
      this.dependencies.logger.info(
        {
          channelId: this.dependencies.config.channelId,
          challengeNumber: challenge.challengeNumber,
        },
        'STEM code-fix inactivity timeout revealed the fix and advanced the challenge',
      );
    });
  }

  public async resetChallenge(): Promise<string | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemCodeFixState(rootState[STATE_KEY]);
      const previousTitle = state.challenge?.title;
      state.challenge = null;
      writeStemCodeFixState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.publishNextChallenge(
        rootState,
        state,
        '🔄 The previous Code Fix challenge was reset by a moderator.',
      );
      return previousTitle;
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemCodeFixState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.correctFixes, limit);
    });
  }

  public async handleMessage(message: StemCodeFixMessage): Promise<void> {
    if (!this.isEnabled() || message.channelId !== this.dependencies.config.channelId) {
      return;
    }

    if (message.authorIsBot || message.content.trim().length === 0) {
      return;
    }

    await this.enqueue(() => this.processMessage(message));
  }

  private async processMessage(message: StemCodeFixMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readStemCodeFixState(rootState[STATE_KEY]);
    const challenge = state.challenge;
    if (!challenge || state.processedMessageIds.includes(message.id)) {
      return;
    }

    if (isDiscordMessageBefore(message.id, challenge.messageId)) {
      state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
      writeStemCodeFixState(rootState, state);
      await this.dependencies.state.save(rootState);
      return;
    }

    let result: CodeFixAnswerResult;
    try {
      result = await this.evaluateAnswer(challenge, message.content);
    } catch (error: unknown) {
      await this.react(message, EVALUATION_FAILURE_REACTION);
      this.dependencies.logger.warn(
        {
          err: error,
          channelId: message.channelId,
          messageId: message.id,
          challengeId: challenge.id,
        },
        'STEM code-fix answer could not be evaluated; no attempt was counted',
      );
      return;
    }

    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    if (result === 'unclear') {
      writeStemCodeFixState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, UNCLEAR_REACTION);
      return;
    }

    if (result === 'correct') {
      await this.completeChallenge(rootState, state, challenge, message);
      return;
    }

    challenge.wrongAttempts += 1;
    if (challenge.wrongAttempts >= this.dependencies.config.maxWrongAnswers) {
      state.challenge = null;
      writeStemCodeFixState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, WRONG_REACTION);
      await this.publishNextChallenge(
        rootState,
        state,
        `The fix was: **${challenge.answer}**.\n${challenge.explanation}`,
      );
      return;
    }

    writeStemCodeFixState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, WRONG_REACTION);
  }

  private async evaluateAnswer(
    challenge: StemCodeFixChallengeState,
    answer: string,
  ): Promise<CodeFixAnswerResult> {
    const normalizedAnswer = normalizeCodeFixAnswer(answer);
    const acceptedAnswers = [challenge.answer, ...challenge.acceptedAnswers].map(
      normalizeCodeFixAnswer,
    );
    if (normalizedAnswer.length > 0 && acceptedAnswers.includes(normalizedAnswer)) {
      return 'correct';
    }

    return this.dependencies.engine.evaluateAnswer(challenge, answer.slice(0, 500));
  }

  private async completeChallenge(
    rootState: JsonState,
    state: StemCodeFixState,
    challenge: StemCodeFixChallengeState,
    message: StemCodeFixMessage,
  ): Promise<void> {
    state.challenge = null;
    state.correctFixes[message.authorId] = (state.correctFixes[message.authorId] ?? 0) + 1;
    writeStemCodeFixState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, PASS_REACTION);
    await this.recordGameParticipation(message.authorId, message);
    await this.publishNextChallenge(
      rootState,
      state,
      `🎉 <@${message.authorId}> fixed it!\n${challenge.explanation}`,
    );
  }

  private async publishNextChallenge(
    rootState: JsonState,
    state: StemCodeFixState,
    leadIn?: string,
  ): Promise<void> {
    let challenge: CodeFixChallenge | undefined;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = await this.dependencies.engine.generateChallenge({
        topic: this.dependencies.config.topic,
        targetAgeMin: this.dependencies.config.targetAgeMin,
        targetAgeMax: this.dependencies.config.targetAgeMax,
        avoidChallenges: state.recentChallenges,
      });
      if (
        candidate.code.trim().length > 0 &&
        candidate.prompt.trim().length > 0 &&
        !state.recentChallenges.some(
          (recent) =>
            normalizeCodeFixAnswer(recent.title) === normalizeCodeFixAnswer(candidate.title),
        )
      ) {
        challenge = candidate;
        break;
      }

      this.dependencies.logger.warn(
        { attempt, title: candidate.title },
        'OpenAI code-fix generated a repeated or invalid challenge',
      );
    }

    if (!challenge) {
      throw new Error('OpenAI code-fix could not generate a valid challenge');
    }

    const challengeNumber = state.nextChallengeNumber;
    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      formatStemCodeFix(challenge, challengeNumber, leadIn),
    );
    state.challenge = {
      ...challenge,
      id: this.idFactory(),
      messageId,
      challengeNumber,
      wrongAttempts: 0,
      askedAt: this.currentTime().toISOString(),
    };
    state.nextChallengeNumber += 1;
    state.recentChallenges = [
      ...state.recentChallenges,
      { title: challenge.title, answer: challenge.answer },
    ].slice(-MAX_RECENT_CHALLENGES);
    writeStemCodeFixState(rootState, state);
    await this.dependencies.state.save(rootState);
  }

  private async recordGameParticipation(
    authorId: string,
    message: StemCodeFixMessage,
  ): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(authorId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, userId: authorId },
        'STEM code-fix game XP could not be recorded',
      );
    }
  }

  private async react(message: StemCodeFixMessage, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'STEM code-fix reaction could not be added',
      );
    }
  }

  private isEnabled(): boolean {
    return this.dependencies.config.enabled && Boolean(this.dependencies.config.channelId);
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.eventQueue.catch(() => undefined).then(work);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export function createStemCodeFixService(
  dependencies: StemCodeFixServiceDependencies,
): StemCodeFixService {
  return new PersistentStemCodeFixService(dependencies);
}

export function formatStemCodeFix(
  challenge: CodeFixChallenge,
  challengeNumber: number,
  leadIn?: string,
): string {
  const code = stripCodeFence(challenge.code);
  return [
    leadIn,
    `💻 **Code Fix ${challengeNumber}** · ${challenge.title}`,
    challenge.prompt,
    `\`\`\`${challenge.language}\n${code}\n\`\`\``,
    'What should be fixed?',
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}

function normalizeCodeFixAnswer(value: string): string {
  return value.toLocaleLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

function readStemCodeFixState(value: unknown): StemCodeFixState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialState();
  }

  const challenge = readChallengeState(value.challenge);
  const recentChallenges = Array.isArray(value.recentChallenges)
    ? value.recentChallenges.filter(isChallengeHistory).slice(-MAX_RECENT_CHALLENGES)
    : [];
  const processedMessageIds = Array.isArray(value.processedMessageIds)
    ? value.processedMessageIds
        .filter((id): id is string => typeof id === 'string')
        .slice(-MAX_PROCESSED_MESSAGE_IDS)
    : [];
  const nextChallengeNumber =
    typeof value.nextChallengeNumber === 'number' &&
    Number.isSafeInteger(value.nextChallengeNumber) &&
    value.nextChallengeNumber > 0
      ? value.nextChallengeNumber
      : 1;

  return {
    version: 1,
    nextChallengeNumber,
    challenge,
    correctFixes: readMinigameScores(value.correctFixes),
    recentChallenges,
    processedMessageIds,
  };
}

function readChallengeState(value: unknown): StemCodeFixChallengeState | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.messageId !== 'string' ||
    !isCodeFixLanguage(value.language) ||
    typeof value.title !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.answer !== 'string' ||
    typeof value.explanation !== 'string' ||
    !Array.isArray(value.acceptedAnswers) ||
    !value.acceptedAnswers.every((answer): answer is string => typeof answer === 'string') ||
    typeof value.challengeNumber !== 'number' ||
    !Number.isSafeInteger(value.challengeNumber) ||
    value.challengeNumber < 1 ||
    typeof value.wrongAttempts !== 'number' ||
    !Number.isSafeInteger(value.wrongAttempts) ||
    value.wrongAttempts < 0 ||
    typeof value.askedAt !== 'string'
  ) {
    return null;
  }

  return {
    id: value.id,
    messageId: value.messageId,
    language: value.language,
    title: value.title,
    prompt: value.prompt,
    code: value.code,
    answer: value.answer,
    acceptedAnswers: value.acceptedAnswers,
    explanation: value.explanation,
    challengeNumber: value.challengeNumber,
    wrongAttempts: value.wrongAttempts,
    askedAt: value.askedAt,
  };
}

function isCodeFixLanguage(value: unknown): value is CodeFixChallenge['language'] {
  return value === 'python' || value === 'javascript' || value === 'typescript';
}

function isChallengeHistory(value: unknown): value is StemCodeFixChallengeHistory {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    typeof value.answer === 'string' &&
    value.answer.trim().length > 0
  );
}

function createInitialState(): StemCodeFixState {
  return {
    version: 1,
    nextChallengeNumber: 1,
    challenge: null,
    correctFixes: {},
    recentChallenges: [],
    processedMessageIds: [],
  };
}

function writeStemCodeFixState(rootState: JsonState, state: StemCodeFixState): void {
  rootState[STATE_KEY] = state;
}

function rememberMessageId(messageIds: readonly string[], messageId: string): string[] {
  return [...messageIds, messageId].slice(-MAX_PROCESSED_MESSAGE_IDS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
