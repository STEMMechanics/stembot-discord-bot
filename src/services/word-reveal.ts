import { randomUUID } from 'node:crypto';
import type { APIEmbed } from 'discord.js';

import type {
  WordRevealChallenge,
  WordRevealDifficulty,
  WordRevealGenerator,
} from '../integrations/openai-word-reveal.js';
import type { AppLogger } from '../logging/logger.js';
import { isDiscordMessageBefore } from './message-order.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';
import type { UserLevelService } from './user-levels.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface StemWordRevealConfig {
  enabled: boolean;
  channelId?: string;
  retryIntervalMs: number;
  topic: string;
  targetAgeMin: number;
  targetAgeMax: number;
  difficulty: WordRevealDifficulty;
  maxWrongGuesses: number;
  idleTimeoutMs?: number;
}

export interface StemWordRevealMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  react(emoji: string): Promise<void>;
  reply(content: string): Promise<void>;
}

export interface StemWordRevealPublisher {
  send(channelId: string, message: StemWordRevealPublisherMessage): Promise<string>;
  edit(
    channelId: string,
    messageId: string,
    message: StemWordRevealPublisherMessage,
  ): Promise<boolean>;
}

export interface StemWordRevealPublisherMessage {
  embeds: APIEmbed[];
}

export interface StemWordRevealService {
  initialize(): Promise<void>;
  ensureRound(): Promise<void>;
  checkInactivity(): Promise<void>;
  resetRound(): Promise<string | undefined>;
  handleMessage(message: StemWordRevealMessage): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

interface StemWordRevealRoundState extends WordRevealChallenge {
  id: string;
  messageId: string;
  roundNumber: number;
  triedLetters: string[];
  revealedLetters: string[];
  wrongGuesses: number;
  startedAt: string;
}

interface StemWordRevealState {
  version: 1;
  nextRoundNumber: number;
  round: StemWordRevealRoundState | null;
  correctGuesses: Record<string, number>;
  recentWords: string[];
  processedMessageIds: string[];
}

interface StemWordRevealServiceDependencies {
  config: StemWordRevealConfig;
  generator: WordRevealGenerator;
  publisher: StemWordRevealPublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
  clock?: () => Date;
  idFactory?: () => string;
}

const STATE_KEY = 'stemWordReveal';
const PASS_REACTION = '✅';
const WRONG_REACTION = '❌';
const UNCLEAR_REACTION = '🤔';
const MAX_RECENT_WORDS = 50;
const MAX_PROCESSED_MESSAGE_IDS = 500;
const MAX_GENERATION_ATTEMPTS = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 259200000;
const DEFAULT_MAX_WRONG_GUESSES = 8;
const MYSTERY_LAB_BLUE = 0x3498db;

export class PersistentStemWordRevealService implements StemWordRevealService {
  private readonly currentTime: () => Date;
  private readonly idFactory: () => string;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: StemWordRevealServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
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
      const state = readStemWordRevealState(rootState[STATE_KEY]);
      if (state.round) {
        return;
      }

      await this.publishNextRound(rootState, state);
    });
  }

  public async checkInactivity(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemWordRevealState(rootState[STATE_KEY]);
      const round = state.round;
      if (!round) {
        return;
      }

      const startedAt = Date.parse(round.startedAt);
      const idleTimeoutMs = this.dependencies.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      if (!Number.isFinite(startedAt) || this.currentTime().getTime() - startedAt < idleTimeoutMs) {
        return;
      }

      state.round = null;
      writeStemWordRevealState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.editBoardSafely(
        round,
        formatWordRevealProgress(
          round,
          this.dependencies.config.maxWrongGuesses,
          `⏰ This mystery went quiet for too long. The answer was **${round.word.toUpperCase()}**.`,
          true,
        ),
      );
      await this.publishNextRound(rootState, state, '⏰ A fresh Mystery Lab round is ready.');
      this.dependencies.logger.info(
        { channelId: this.dependencies.config.channelId, roundNumber: round.roundNumber },
        'STEM word reveal inactivity timeout revealed the answer and advanced the round',
      );
    });
  }

  public async resetRound(): Promise<string | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemWordRevealState(rootState[STATE_KEY]);
      const previousRound = state.round;
      const previousWord = previousRound?.word;
      state.round = null;
      writeStemWordRevealState(rootState, state);
      await this.dependencies.state.save(rootState);
      if (previousRound) {
        await this.editBoardSafely(
          previousRound,
          formatWordRevealProgress(
            previousRound,
            this.dependencies.config.maxWrongGuesses,
            '🔄 A moderator reset the Mystery Lab.',
            true,
          ),
        );
      }
      await this.publishNextRound(
        rootState,
        state,
        '🔄 A moderator reset the Mystery Lab. A fresh mystery is ready!',
      );
      return previousWord;
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemWordRevealState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.correctGuesses, limit);
    });
  }

  public async handleMessage(message: StemWordRevealMessage): Promise<void> {
    if (!this.isEnabled() || message.channelId !== this.dependencies.config.channelId) {
      return;
    }

    if (message.authorIsBot || message.content.trim().length === 0) {
      return;
    }

    await this.enqueue(() => this.processMessage(message));
  }

  private async processMessage(message: StemWordRevealMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readStemWordRevealState(rootState[STATE_KEY]);
    const round = state.round;
    if (!round || state.processedMessageIds.includes(message.id)) {
      return;
    }

    if (isDiscordMessageBefore(message.id, round.messageId)) {
      state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
      writeStemWordRevealState(rootState, state);
      await this.dependencies.state.save(rootState);
      return;
    }

    const guess = normalizeWordRevealGuess(message.content);
    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    if (!guess) {
      writeStemWordRevealState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, UNCLEAR_REACTION);
      await this.replySafely(message, '🤔 Send one letter or the whole word to make a guess.');
      return;
    }

    const answer = normalizeWordRevealWord(round.word);
    if (guess.length > 1) {
      if (guess === answer) {
        await this.completeRound(rootState, state, round, message);
        return;
      }

      await this.handleWrongGuess(
        rootState,
        state,
        round,
        message,
        `The whole-word guess **${guess}** was not right.`,
      );
      return;
    }

    if (round.triedLetters.includes(guess)) {
      writeStemWordRevealState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, UNCLEAR_REACTION);
      await this.editBoardSafely(
        round,
        formatWordRevealProgress(
          round,
          this.dependencies.config.maxWrongGuesses,
          `🤔 The letter **${guess.toUpperCase()}** has already been checked in this mystery.`,
        ),
      );
      return;
    }

    round.triedLetters = [...round.triedLetters, guess];
    if (!answer.includes(guess)) {
      await this.handleWrongGuess(
        rootState,
        state,
        round,
        message,
        `The letter **${guess.toUpperCase()}** is not in the word.`,
      );
      return;
    }

    round.revealedLetters = [...new Set([...round.revealedLetters, guess])];
    if ([...new Set(answer)].every((letter) => round.revealedLetters.includes(letter))) {
      await this.completeRound(rootState, state, round, message);
      return;
    }

    writeStemWordRevealState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, PASS_REACTION);
    await this.editBoardSafely(
      round,
      formatWordRevealProgress(
        round,
        this.dependencies.config.maxWrongGuesses,
        `✅ **${guess.toUpperCase()}** is in the mystery word!`,
      ),
    );
  }

  private async handleWrongGuess(
    rootState: JsonState,
    state: StemWordRevealState,
    round: StemWordRevealRoundState,
    message: StemWordRevealMessage,
    feedback: string,
  ): Promise<void> {
    round.wrongGuesses += 1;
    if (round.wrongGuesses >= this.dependencies.config.maxWrongGuesses) {
      state.round = null;
      writeStemWordRevealState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, WRONG_REACTION);
      await this.editBoardSafely(
        round,
        formatWordRevealProgress(
          round,
          this.dependencies.config.maxWrongGuesses,
          `${feedback}\n\n💥 The mystery is over! The answer was **${round.word.toUpperCase()}**.`,
          true,
        ),
      );
      await this.publishNextRound(rootState, state, '💥 A fresh Mystery Lab round is ready.');
      return;
    }

    writeStemWordRevealState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, WRONG_REACTION);
    await this.editBoardSafely(
      round,
      formatWordRevealProgress(round, this.dependencies.config.maxWrongGuesses, `❌ ${feedback}`),
    );
  }

  private async completeRound(
    rootState: JsonState,
    state: StemWordRevealState,
    round: StemWordRevealRoundState,
    message: StemWordRevealMessage,
  ): Promise<void> {
    state.round = null;
    state.correctGuesses[message.authorId] = (state.correctGuesses[message.authorId] ?? 0) + 1;
    writeStemWordRevealState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, PASS_REACTION);
    await this.recordGameParticipation(message.authorId, message);
    await this.editBoardSafely(
      round,
      formatWordRevealProgress(
        round,
        this.dependencies.config.maxWrongGuesses,
        `🎉 <@${message.authorId}> solved the mystery! The word was **${round.word.toUpperCase()}**.\n🏆 +1 solved round!`,
        true,
      ),
    );
    await this.publishNextRound(rootState, state, '🎉 A fresh Mystery Lab round is ready.');
  }

  private async publishNextRound(
    rootState: JsonState,
    state: StemWordRevealState,
    leadIn?: string,
  ): Promise<void> {
    const avoidWords = state.recentWords;
    let challenge: WordRevealChallenge | undefined;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = await this.dependencies.generator.generateChallenge({
        topic: this.dependencies.config.topic,
        targetAgeMin: this.dependencies.config.targetAgeMin,
        targetAgeMax: this.dependencies.config.targetAgeMax,
        difficulty: this.dependencies.config.difficulty,
        avoidWords,
      });
      const word = normalizeWordRevealWord(candidate.word);
      if (
        isValidWordRevealWord(word, this.dependencies.config.difficulty) &&
        !avoidWords.includes(word) &&
        candidate.hint.trim().length > 0 &&
        !containsWholeWord(candidate.hint, word)
      ) {
        challenge = { word, hint: candidate.hint.trim() };
        break;
      }

      this.dependencies.logger.warn(
        { attempt, word: candidate.word },
        'OpenAI word reveal generated an invalid or repeated challenge',
      );
    }

    if (!challenge) {
      throw new Error('OpenAI word reveal could not generate a valid challenge');
    }

    const roundNumber = state.nextRoundNumber;
    const messageId = await this.dependencies.publisher.send(this.dependencies.config.channelId!, {
      embeds: [
        formatStemWordReveal(
          challenge,
          roundNumber,
          leadIn,
          this.dependencies.config.maxWrongGuesses,
        ),
      ],
    });
    state.round = {
      ...challenge,
      id: this.idFactory(),
      messageId,
      roundNumber,
      triedLetters: [],
      revealedLetters: [],
      wrongGuesses: 0,
      startedAt: this.currentTime().toISOString(),
    };
    state.nextRoundNumber += 1;
    state.recentWords = [...state.recentWords, challenge.word].slice(-MAX_RECENT_WORDS);
    writeStemWordRevealState(rootState, state);
    await this.dependencies.state.save(rootState);
  }

  private async editBoardSafely(round: StemWordRevealRoundState, embed: APIEmbed): Promise<void> {
    try {
      const edited = await this.dependencies.publisher.edit(
        this.dependencies.config.channelId!,
        round.messageId,
        {
          embeds: [embed],
        },
      );
      if (!edited) {
        this.dependencies.logger.warn(
          { channelId: this.dependencies.config.channelId, messageId: round.messageId },
          'STEM word reveal board could not be found for editing',
        );
      }
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: this.dependencies.config.channelId, messageId: round.messageId },
        'STEM word reveal board could not be updated',
      );
    }
  }

  private async recordGameParticipation(
    authorId: string,
    message: StemWordRevealMessage,
  ): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(authorId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, userId: authorId },
        'STEM word reveal game XP could not be recorded',
      );
    }
  }

  private async react(message: StemWordRevealMessage, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'STEM word reveal reaction could not be added',
      );
    }
  }

  private async replySafely(message: StemWordRevealMessage, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'STEM word reveal reply could not be sent',
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

export function createStemWordRevealService(
  dependencies: StemWordRevealServiceDependencies,
): StemWordRevealService {
  return new PersistentStemWordRevealService(dependencies);
}

export function formatStemWordReveal(
  challenge: WordRevealChallenge,
  roundNumber: number,
  leadIn?: string,
  maxWrongGuesses = DEFAULT_MAX_WRONG_GUESSES,
): APIEmbed {
  return formatWordRevealEmbed(challenge, roundNumber, [], [], 0, maxWrongGuesses, leadIn);
}

function formatWordRevealProgress(
  round: StemWordRevealRoundState,
  maxWrongGuesses: number,
  leadIn?: string,
  revealAnswer = false,
): APIEmbed {
  return formatWordRevealEmbed(
    round,
    round.roundNumber,
    round.triedLetters,
    round.revealedLetters,
    round.wrongGuesses,
    maxWrongGuesses,
    leadIn,
    revealAnswer,
  );
}

function formatWordRevealEmbed(
  challenge: WordRevealChallenge,
  roundNumber: number,
  triedLetters: readonly string[],
  revealedLetters: readonly string[],
  wrongGuesses: number,
  maxWrongGuesses: number,
  leadIn?: string,
  revealAnswer = false,
): APIEmbed {
  const word = normalizeWordRevealWord(challenge.word);
  const guessed = new Set([...revealedLetters, ...(revealAnswer ? [...word] : [])]);
  const displayedWord = [...word]
    .map((letter) => (guessed.has(letter) ? toRegionalIndicator(letter) : '🔵'))
    .join(' ');
  const guesses = triedLetters.map((letter) => letter.toUpperCase()).join(',') || 'none';
  const status = leadIn ? `\n\n${leadIn}` : '';

  return {
    title: `🕵️ Mystery Lab · Round ${roundNumber}`,
    color: MYSTERY_LAB_BLUE,
    description: `💡 **Clue**\n${challenge.hint}${status}`,
    fields: [
      {
        name: '🔤 Guesses',
        value: `\`${guesses}\``,
        inline: false,
      },
      {
        name: '🧩 Word',
        value: displayedWord,
        inline: false,
      },
    ],
    footer: {
      text: `Guess one letter or the whole word in this channel · ${wrongGuesses}/${Math.max(1, maxWrongGuesses)} wrong guesses`,
    },
  };
}

function toRegionalIndicator(letter: string): string {
  return `:regional_indicator_${letter.toLowerCase()}:`;
}

function normalizeWordRevealGuess(value: string): string | undefined {
  const normalized = normalizeWordRevealWord(value).replace(/\s+/g, '');
  return /^[a-z]$/.test(normalized) || /^[a-z]{2,30}$/.test(normalized) ? normalized : undefined;
}

function normalizeWordRevealWord(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isValidWordRevealWord(word: string, difficulty: WordRevealDifficulty): boolean {
  if (!/^[a-z]{4,16}$/.test(word)) {
    return false;
  }

  return difficulty !== 'challenging' || word.length >= 6;
}

function containsWholeWord(value: string, word: string): boolean {
  const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escapedWord}\\b`, 'i').test(value);
}

function readStemWordRevealState(value: unknown): StemWordRevealState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialState();
  }

  const round = readRoundState(value.round);
  const recentWords = Array.isArray(value.recentWords)
    ? value.recentWords
        .filter((word): word is string => typeof word === 'string')
        .map(normalizeWordRevealWord)
        .filter((word) => /^[a-z]{4,16}$/.test(word))
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

  return {
    version: 1,
    nextRoundNumber,
    round,
    correctGuesses: readMinigameScores(value.correctGuesses),
    recentWords,
    processedMessageIds,
  };
}

function readRoundState(value: unknown): StemWordRevealRoundState | null {
  if (!isRecord(value)) {
    return null;
  }

  const word = normalizeWordRevealWord(typeof value.word === 'string' ? value.word : '');
  const hint = typeof value.hint === 'string' ? value.hint.trim() : '';
  if (
    typeof value.id !== 'string' ||
    typeof value.messageId !== 'string' ||
    typeof value.roundNumber !== 'number' ||
    !Number.isSafeInteger(value.roundNumber) ||
    value.roundNumber < 1 ||
    !/^[a-z]{4,16}$/.test(word) ||
    hint.length === 0 ||
    typeof value.startedAt !== 'string'
  ) {
    return null;
  }

  const triedLetters = readLetters(value.triedLetters);
  const revealedLetters = readLetters(value.revealedLetters);
  const wrongGuesses =
    typeof value.wrongGuesses === 'number' &&
    Number.isSafeInteger(value.wrongGuesses) &&
    value.wrongGuesses >= 0
      ? value.wrongGuesses
      : 0;
  return {
    id: value.id,
    messageId: value.messageId,
    roundNumber: value.roundNumber,
    word,
    hint,
    triedLetters,
    revealedLetters,
    wrongGuesses,
    startedAt: value.startedAt,
  };
}

function readLetters(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((letter): letter is string => /^[a-z]$/.test(letter)))]
    : [];
}

function createInitialState(): StemWordRevealState {
  return {
    version: 1,
    nextRoundNumber: 1,
    round: null,
    correctGuesses: {},
    recentWords: [],
    processedMessageIds: [],
  };
}

function writeStemWordRevealState(rootState: JsonState, state: StemWordRevealState): void {
  rootState[STATE_KEY] = state;
}

function rememberMessageId(messageIds: readonly string[], messageId: string): string[] {
  return [...messageIds, messageId].slice(-MAX_PROCESSED_MESSAGE_IDS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
