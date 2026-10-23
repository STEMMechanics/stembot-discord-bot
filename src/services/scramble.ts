import { randomUUID } from 'node:crypto';

import type {
  ScrambleWord,
  ScrambleWordGenerator,
  ScrambleHintOptions,
  ScrambleWordOptions,
} from '../integrations/openai-scramble.js';
import type { AppLogger } from '../logging/logger.js';
import type { UserLevelService } from './user-levels.js';
import { isDiscordMessageBefore } from './message-order.js';
import type { JsonState, StateStore } from '../state/state-store.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';
import { isMinigameHintRequest } from './minigame-hints.js';

export interface StemScrambleConfig {
  enabled: boolean;
  channelId?: string;
  retryIntervalMs: number;
  topic: string;
  targetAgeMin: number;
  targetAgeMax: number;
}

export interface StemScrambleMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  hintRequest?: boolean;
  react(emoji: string): Promise<void>;
  reply(content: string): Promise<void>;
}

export interface StemScramblePublisher {
  send(channelId: string, content: string): Promise<string>;
}

export interface StemScrambleService {
  initialize(): Promise<void>;
  ensureRound(): Promise<void>;
  resetRound(): Promise<string | undefined>;
  handleMessage(message: StemScrambleMessage): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface StemScrambleRoundState {
  id: string;
  messageId: string;
  roundNumber: number;
  word: string;
  hint: string;
  hints: string[];
  scrambled: string;
  wrongAttempts: number;
  startedAt: string;
}

interface StemScrambleState {
  version: 1;
  nextRoundNumber: number;
  round: StemScrambleRoundState | null;
  correctGuesses: Record<string, number>;
  recentWords: string[];
  processedMessageIds: string[];
}

interface StemScrambleServiceDependencies {
  config: StemScrambleConfig;
  generator: ScrambleWordGenerator;
  publisher: StemScramblePublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
  clock?: () => Date;
  random?: () => number;
  idFactory?: () => string;
}

const STATE_KEY = 'stemScramble';
const PASS_REACTION = '✅';
const WRONG_REACTION = '❌';
const MAX_WRONG_ATTEMPTS = 5;
const MAX_RECENT_WORDS = 50;
const MAX_PROCESSED_MESSAGE_IDS = 500;
const MAX_WORD_GENERATION_ATTEMPTS = 3;
const MAX_HINTS_PER_ROUND = 5;
const SCRAMBLE_HINT_USER_COOLDOWN_MS = 5_000;
const SCRAMBLE_HINT_GLOBAL_WINDOW_MS = 60_000;
const SCRAMBLE_HINT_GLOBAL_LIMIT = 30;

export class PersistentStemScrambleService implements StemScrambleService {
  private readonly currentTime: () => Date;
  private readonly random: () => number;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly lastHintAt = new Map<string, number>();
  private hintWindowStartedAt = 0;
  private hintWindowRequestCount = 0;

  public constructor(private readonly dependencies: StemScrambleServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  public async initialize(): Promise<void> {
    await this.ensureRound();
  }

  public async ensureRound(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemScrambleState(rootState[STATE_KEY]);
      if (state.round) {
        return;
      }

      await this.publishNextRound(rootState, state);
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemScrambleState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.correctGuesses, limit);
    });
  }

  public async resetRound(): Promise<string | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemScrambleState(rootState[STATE_KEY]);
      const previousWord = state.round?.word;
      state.round = null;
      writeStemScrambleState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.publishNextRound(
        rootState,
        state,
        '🔄 The previous scramble was reset by a moderator.',
      );
      return previousWord;
    });
  }

  public async handleMessage(message: StemScrambleMessage): Promise<void> {
    if (!this.isEnabled() || message.channelId !== this.dependencies.config.channelId) {
      return;
    }

    if (message.authorIsBot || message.content.trim().length === 0) {
      return;
    }

    await this.enqueue(() => this.processMessage(message));
  }

  private async processMessage(message: StemScrambleMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readStemScrambleState(rootState[STATE_KEY]);
    const round = state.round;
    if (!round || state.processedMessageIds.includes(message.id)) {
      return;
    }

    if (isDiscordMessageBefore(message.id, round.messageId)) {
      state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
      writeStemScrambleState(rootState, state);
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          roundNumber: round.roundNumber,
          roundMessageId: round.messageId,
        },
        'STEM scramble answer skipped because it was sent before the active round',
      );
      return;
    }

    if (message.hintRequest === true || isMinigameHintRequest(message.content)) {
      await this.processHintRequest(rootState, state, round, message);
      return;
    }

    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    const answer = normalizeScrambleText(message.content);
    if (answer !== normalizeScrambleText(round.word)) {
      round.wrongAttempts += 1;
      if (round.wrongAttempts >= MAX_WRONG_ATTEMPTS) {
        state.round = null;
        writeStemScrambleState(rootState, state);
        await this.dependencies.state.save(rootState);
        await this.react(message, WRONG_REACTION);
        await this.publishNextRound(rootState, state, `The answer was **${round.word}**.`);
        this.dependencies.logger.info(
          {
            channelId: message.channelId,
            messageId: message.id,
            roundNumber: round.roundNumber,
            wrongAttempts: round.wrongAttempts,
          },
          'STEM scramble answer limit reached; answer revealed and round advanced',
        );
        return;
      }

      writeStemScrambleState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, WRONG_REACTION);
      this.dependencies.logger.info(
        { channelId: message.channelId, messageId: message.id, roundNumber: round.roundNumber },
        'STEM scramble answer was incorrect; round remains open',
      );
      return;
    }

    state.round = null;
    state.correctGuesses[message.authorId] = (state.correctGuesses[message.authorId] ?? 0) + 1;
    writeStemScrambleState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, PASS_REACTION);
    await this.recordGameParticipation(message.authorId, message);

    await this.publishNextRound(rootState, state);
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        roundNumber: round.roundNumber,
        userId: message.authorId,
      },
      'STEM scramble answer accepted',
    );
  }

  private async processHintRequest(
    rootState: JsonState,
    state: StemScrambleState,
    round: StemScrambleRoundState,
    message: StemScrambleMessage,
  ): Promise<void> {
    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    writeStemScrambleState(rootState, state);
    await this.dependencies.state.save(rootState);

    if (round.hints.length >= MAX_HINTS_PER_ROUND) {
      await this.replySafely(
        message,
        '💡 I have given all the extra clues I have for this round. Have a go with the clues above!',
      );
      return;
    }

    if (!this.canRequestHint(message.authorId)) {
      await this.replySafely(
        message,
        '💡 Give me a moment to think before asking for another clue.',
      );
      return;
    }

    let hint: string | undefined;
    const generator = this.dependencies.generator;
    if (generator.generateHint) {
      const options: ScrambleHintOptions = {
        word: round.word,
        topic: this.dependencies.config.topic,
        targetAgeMin: this.dependencies.config.targetAgeMin,
        targetAgeMax: this.dependencies.config.targetAgeMax,
        previousHints: round.hints,
      };
      try {
        const generatedHint = (await generator.generateHint(options)).trim();
        if (
          generatedHint &&
          !round.hints.some((previousHint) => sameHint(previousHint, generatedHint)) &&
          !containsWholeWord(generatedHint, round.word)
        ) {
          hint = generatedHint;
        }
      } catch (error: unknown) {
        this.dependencies.logger.warn(
          { err: error, channelId: message.channelId, roundNumber: round.roundNumber },
          'STEM scramble hint could not be generated; using the original clue',
        );
      }
    }

    if (!hint) {
      hint = round.hint;
    }

    round.hints = [...round.hints, hint].slice(-MAX_HINTS_PER_ROUND);
    writeStemScrambleState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.replySafely(message, `💡 Another hint: ${hint}`);
  }

  private async publishNextRound(
    rootState: JsonState,
    state: StemScrambleState,
    leadIn?: string,
  ): Promise<void> {
    const options: ScrambleWordOptions = {
      topic: this.dependencies.config.topic,
      targetAgeMin: this.dependencies.config.targetAgeMin,
      targetAgeMax: this.dependencies.config.targetAgeMax,
      ...(state.recentWords.length > 0 ? { avoidWords: state.recentWords } : {}),
    };
    const word = await this.generateUniqueWord(options, state.recentWords);
    const scrambled = scrambleWord(word.word, this.random);
    if (!hasSameLetters(word.word, scrambled)) {
      throw new Error('STEM scramble generated a scrambled word with mismatched letters');
    }
    const roundNumber = state.nextRoundNumber;
    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      formatStemScramble(word, scrambled, roundNumber, leadIn),
    );
    state.round = {
      id: this.idFactory(),
      messageId,
      roundNumber,
      word: word.word,
      hint: word.hint,
      hints: [word.hint],
      scrambled,
      wrongAttempts: 0,
      startedAt: this.currentTime().toISOString(),
    };
    state.nextRoundNumber += 1;
    state.recentWords = [...state.recentWords, word.word].slice(-MAX_RECENT_WORDS);
    writeStemScrambleState(rootState, state);
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      { channelId: this.dependencies.config.channelId, roundNumber },
      'STEM scramble round posted',
    );
  }

  private async generateUniqueWord(
    options: ScrambleWordOptions,
    recentWords: readonly string[],
  ): Promise<ScrambleWord> {
    for (let attempt = 1; attempt <= MAX_WORD_GENERATION_ATTEMPTS; attempt += 1) {
      const word = await this.dependencies.generator.generateWord(options);
      if (
        !recentWords.some(
          (recentWord) => normalizeScrambleText(recentWord) === normalizeScrambleText(word.word),
        )
      ) {
        return word;
      }

      this.dependencies.logger.warn(
        {
          attempt,
          maxAttempts: MAX_WORD_GENERATION_ATTEMPTS,
          word: word.word,
        },
        'STEM scramble generated a recent word again; requesting a replacement',
      );
    }

    throw new Error(
      `STEM scramble generated a duplicate word ${MAX_WORD_GENERATION_ATTEMPTS} times`,
    );
  }

  private async recordGameParticipation(
    userId: string,
    message: StemScrambleMessage,
  ): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(userId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, userId },
        'STEM scramble game XP could not be recorded',
      );
    }
  }

  private async react(message: StemScrambleMessage, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'STEM scramble reaction could not be added',
      );
    }
  }

  private async replySafely(message: StemScrambleMessage, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'STEM scramble hint reply could not be sent',
      );
    }
  }

  private canRequestHint(authorId: string): boolean {
    const now = Date.now();
    const lastRequestedAt = this.lastHintAt.get(authorId);
    if (lastRequestedAt && now - lastRequestedAt < SCRAMBLE_HINT_USER_COOLDOWN_MS) {
      return false;
    }

    if (now - this.hintWindowStartedAt >= SCRAMBLE_HINT_GLOBAL_WINDOW_MS) {
      this.hintWindowStartedAt = now;
      this.hintWindowRequestCount = 0;
    }

    if (this.hintWindowRequestCount >= SCRAMBLE_HINT_GLOBAL_LIMIT) {
      return false;
    }

    this.lastHintAt.set(authorId, now);
    this.hintWindowRequestCount += 1;
    return true;
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

export function createStemScrambleService(
  dependencies: StemScrambleServiceDependencies,
): StemScrambleService {
  return new PersistentStemScrambleService(dependencies);
}

export function formatStemScramble(
  word: ScrambleWord,
  scrambled: string,
  roundNumber: number,
  leadIn?: string,
): string {
  return [
    leadIn,
    `🔤 **Scramble ${roundNumber}**`,
    `Unscramble: \`${scrambled}\``,
    `Hint: ${word.hint}`,
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}

export function scrambleWord(word: string, random: () => number = Math.random): string {
  const normalized = normalizeScrambleText(word);
  const letters = [...normalized];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const shuffled = [...letters];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.max(0, Math.min(0.999999, random())) * (index + 1));
      const current = shuffled[index];
      const targetLetter = shuffled[target];
      if (current === undefined || targetLetter === undefined) {
        continue;
      }

      shuffled[index] = targetLetter;
      shuffled[target] = current;
    }

    const result = shuffled.join('');
    if (result !== normalized) {
      return result;
    }
  }

  return `${letters.slice(1).join('')}${letters[0] ?? ''}`;
}

function readStemScrambleState(value: unknown): StemScrambleState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialState();
  }

  const round = readRoundState(value.round);
  const recentWords = Array.isArray(value.recentWords)
    ? value.recentWords
        .filter((word): word is string => typeof word === 'string' && word.trim().length > 0)
        .map(normalizeScrambleText)
        .filter((word) => word.length > 0)
        .slice(-MAX_RECENT_WORDS)
    : [];
  const processedMessageIds = Array.isArray(value.processedMessageIds)
    ? value.processedMessageIds
        .filter((id): id is string => typeof id === 'string')
        .slice(-MAX_PROCESSED_MESSAGE_IDS)
    : [];
  const nextRoundNumber =
    typeof value.nextRoundNumber === 'number' &&
    Number.isSafeInteger(value.nextRoundNumber) &&
    value.nextRoundNumber > 0
      ? value.nextRoundNumber
      : 1;

  const correctGuesses = readMinigameScores(value.correctGuesses);

  return {
    version: 1,
    nextRoundNumber,
    round,
    correctGuesses,
    recentWords,
    processedMessageIds,
  };
}

function readRoundState(value: unknown): StemScrambleRoundState | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.messageId !== 'string' ||
    typeof value.roundNumber !== 'number' ||
    !Number.isSafeInteger(value.roundNumber) ||
    typeof value.word !== 'string' ||
    typeof value.hint !== 'string' ||
    typeof value.scrambled !== 'string' ||
    (value.wrongAttempts !== undefined &&
      (typeof value.wrongAttempts !== 'number' ||
        !Number.isSafeInteger(value.wrongAttempts) ||
        value.wrongAttempts < 0)) ||
    typeof value.startedAt !== 'string' ||
    !hasSameLetters(value.word, value.scrambled)
  ) {
    return null;
  }

  return {
    id: value.id,
    messageId: value.messageId,
    roundNumber: value.roundNumber,
    word: value.word,
    hint: value.hint,
    hints:
      Array.isArray(value.hints) &&
      value.hints.every((hint): hint is string => typeof hint === 'string') &&
      value.hints.length > 0
        ? value.hints.slice(-MAX_HINTS_PER_ROUND)
        : [value.hint],
    scrambled: value.scrambled,
    wrongAttempts: typeof value.wrongAttempts === 'number' ? value.wrongAttempts : 0,
    startedAt: value.startedAt,
  };
}

function createInitialState(): StemScrambleState {
  return {
    version: 1,
    nextRoundNumber: 1,
    round: null,
    correctGuesses: {},
    recentWords: [],
    processedMessageIds: [],
  };
}

function writeStemScrambleState(rootState: JsonState, state: StemScrambleState): void {
  rootState[STATE_KEY] = state;
}

function rememberMessageId(messageIds: readonly string[], messageId: string): string[] {
  return [...messageIds.filter((id) => id !== messageId), messageId].slice(
    -MAX_PROCESSED_MESSAGE_IDS,
  );
}

function normalizeScrambleText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^a-z]+/g, '');
}

function hasSameLetters(left: string, right: string): boolean {
  const leftLetters = [...normalizeScrambleText(left)].sort().join('');
  const rightLetters = [...normalizeScrambleText(right)].sort().join('');
  return leftLetters.length > 0 && leftLetters === rightLetters;
}

function sameHint(left: string, right: string): boolean {
  return normalizeScrambleText(left) === normalizeScrambleText(right);
}

function containsWholeWord(value: string, word: string): boolean {
  const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escapedWord}\\b`, 'i').test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
