import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';
import type { StemWordChainThemeValidator } from '../integrations/openai-word-chain.js';
import {
  readMinigameScores,
  toMinigameLeaderboard,
  type MinigameLeaderboardEntry,
} from './minigame-leaderboards.js';
import type { UserLevelService } from './user-levels.js';

export interface StemWordChainConfig {
  enabled: boolean;
  channelId?: string;
  retryIntervalMs: number;
}

export interface StemWordChainMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  react(emoji: string): Promise<void>;
  reply(content: string): Promise<void>;
}

export interface StemWordChainPublisher {
  send(channelId: string, content: string): Promise<string>;
}

export interface StemWordChainService {
  initialize(): Promise<void>;
  ensureRound(): Promise<void>;
  handleMessage(message: StemWordChainMessage): Promise<void>;
  getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]>;
}

export interface StemWordChainTheme {
  name: string;
  words: readonly string[];
}

export const STEM_WORD_CHAIN_THEMES: readonly StemWordChainTheme[] = [
  {
    name: 'Space',
    words: [
      'asteroid',
      'astronaut',
      'comet',
      'dwarf',
      'eclipse',
      'fusion',
      'galaxy',
      'gravity',
      'lunar',
      'mars',
      'meteor',
      'moon',
      'nebula',
      'orbit',
      'planet',
      'radiation',
      'redshift',
      'rocket',
      'rover',
      'satellite',
      'star',
      'telescope',
      'universe',
      'venus',
      'year',
    ],
  },
  {
    name: 'Biology',
    words: [
      'animal',
      'bacteria',
      'cell',
      'chlorophyll',
      'dna',
      'enzyme',
      'fungus',
      'gene',
      'habitat',
      'insect',
      'lizard',
      'mammal',
      'organism',
      'plant',
      'protein',
      'reproduction',
      'root',
      'species',
      'tissue',
      'virus',
      'yeast',
    ],
  },
  {
    name: 'Chemistry',
    words: [
      'atom',
      'base',
      'bond',
      'catalyst',
      'chemical',
      'density',
      'diffusion',
      'electron',
      'element',
      'gas',
      'ion',
      'liquid',
      'metal',
      'molecule',
      'neutron',
      'oxygen',
      'proton',
      'reaction',
      'salt',
      'solution',
      'titration',
      'yield',
    ],
  },
  {
    name: 'Technology',
    words: [
      'algorithm',
      'battery',
      'binary',
      'browser',
      'circuit',
      'code',
      'computer',
      'data',
      'digital',
      'engine',
      'hardware',
      'internet',
      'keyboard',
      'kernel',
      'logic',
      'memory',
      'network',
      'robot',
      'sensor',
      'software',
      'web',
    ],
  },
  {
    name: 'Physics',
    words: [
      'acceleration',
      'dynamics',
      'energy',
      'force',
      'friction',
      'inertia',
      'joule',
      'kinetic',
      'mass',
      'motion',
      'newton',
      'nuclear',
      'power',
      'pressure',
      'quantum',
      'radiation',
      'resistance',
      'resonance',
      'speed',
      'velocity',
      'wave',
      'work',
      'yield',
    ],
  },
];

interface StemWordChainState {
  version: 1;
  themeIndex: number;
  roundNumber: number;
  promptMessageId: string | null;
  lastWord: string | null;
  lastAuthorId: string | null;
  lastMessageId: string | null;
  streak: number;
  bestStreak: number;
  roundStreaks: Record<string, number>;
  bestStreaks: Record<string, number>;
  processedMessageIds: string[];
}

interface StemWordChainServiceDependencies {
  config: StemWordChainConfig;
  publisher: StemWordChainPublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  themeValidator?: StemWordChainThemeValidator;
  userLevels?: UserLevelService;
}

const STATE_KEY = 'stemWordChain';
const PASS_REACTION = '✅';
const FAILURE_REACTION = '❌';
const MAX_PROCESSED_MESSAGE_IDS = 500;
const MAX_THEME_VALIDATION_CACHE_ENTRIES = 500;
const THEME_VALIDATION_USER_COOLDOWN_MS = 5_000;
const THEME_VALIDATION_GLOBAL_WINDOW_MS = 60_000;
const THEME_VALIDATION_GLOBAL_LIMIT = 30;
const MAX_WORD_DEFINITION_CACHE_ENTRIES = 500;
const WORD_DEFINITION_USER_COOLDOWN_MS = 5_000;
const WORD_DEFINITION_GLOBAL_WINDOW_MS = 60_000;
const WORD_DEFINITION_GLOBAL_LIMIT = 30;

export class PersistentStemWordChainService implements StemWordChainService {
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly themeValidationCache = new Map<string, boolean>();
  private readonly lastThemeValidationAt = new Map<string, number>();
  private themeValidationWindowStartedAt = 0;
  private themeValidationWindowRequestCount = 0;
  private definitionQueue: Promise<void> = Promise.resolve();
  private readonly wordDefinitionCache = new Map<string, string>();
  private readonly lastWordDefinitionAt = new Map<string, number>();
  private wordDefinitionWindowStartedAt = 0;
  private wordDefinitionWindowRequestCount = 0;

  public constructor(private readonly dependencies: StemWordChainServiceDependencies) {}

  public async initialize(): Promise<void> {
    await this.ensureRound();
  }

  public async ensureRound(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemWordChainState(rootState[STATE_KEY]);
      if (state.promptMessageId) {
        return;
      }

      await this.publishRound(rootState, state);
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly MinigameLeaderboardEntry[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readStemWordChainState(rootState[STATE_KEY]);
      return toMinigameLeaderboard(state.bestStreaks, limit);
    });
  }

  public async handleMessage(message: StemWordChainMessage): Promise<void> {
    if (!this.isEnabled() || message.channelId !== this.dependencies.config.channelId) {
      return;
    }

    if (message.authorIsBot || message.content.trim().length === 0) {
      return;
    }

    await this.enqueue(() => this.processMessage(message));
  }

  private async processMessage(message: StemWordChainMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readStemWordChainState(rootState[STATE_KEY]);
    if (state.processedMessageIds.includes(message.id)) {
      return;
    }

    const theme = getTheme(state.themeIndex);
    const word = normalizeWordChainWord(message.content);
    const expectedLetter = state.lastWord?.slice(-1) ?? undefined;
    const startsWithExpectedLetter =
      word !== undefined &&
      (!state.lastWord || (expectedLetter !== undefined && word.startsWith(expectedLetter)));
    if (!startsWithExpectedLetter || !word) {
      await this.endRound(rootState, state, message, theme, word);
      return;
    }

    const fitsTheme = await this.isWordInTheme(theme, word, message.authorId);
    if (fitsTheme === undefined) {
      return;
    }

    const valid = fitsTheme;

    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    if (valid && word) {
      state.lastWord = word;
      state.lastAuthorId = message.authorId;
      state.lastMessageId = message.id;
      state.streak += 1;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
      const playerStreak = (state.roundStreaks[message.authorId] ?? 0) + 1;
      state.roundStreaks[message.authorId] = playerStreak;
      state.bestStreaks[message.authorId] = Math.max(
        state.bestStreaks[message.authorId] ?? 0,
        playerStreak,
      );
      writeStemWordChainState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, PASS_REACTION);
      await this.recordGameParticipation(message);
      this.queueWordDefinition(message, theme, word);
      this.dependencies.logger.info(
        {
          channelId: message.channelId,
          messageId: message.id,
          userId: message.authorId,
          theme: theme.name,
          word,
          streak: state.streak,
        },
        'STEM word chain move accepted',
      );
      return;
    }

    await this.endRound(rootState, state, message, theme, word);
  }

  private async endRound(
    rootState: JsonState,
    state: StemWordChainState,
    message: StemWordChainMessage,
    theme: StemWordChainTheme,
    word: string | undefined,
  ): Promise<void> {
    const previousStreak = state.streak;
    const nextThemeIndex = (state.themeIndex + 1) % STEM_WORD_CHAIN_THEMES.length;
    const nextTheme = getTheme(nextThemeIndex);
    state.themeIndex = nextThemeIndex;
    state.roundNumber += 1;
    state.promptMessageId = null;
    state.lastWord = null;
    state.lastAuthorId = null;
    state.lastMessageId = null;
    state.streak = 0;
    state.roundStreaks = {};
    writeStemWordChainState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.react(message, FAILURE_REACTION);
    await this.publishRound(
      rootState,
      state,
      `💥 **${theme.name}** chain over at **${previousStreak}**! The theme is now **${nextTheme.name}**.`,
    );
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        userId: message.authorId,
        previousTheme: theme.name,
        nextTheme: nextTheme.name,
        previousStreak,
        word,
      },
      'STEM word chain round ended',
    );
  }

  private async isWordInTheme(
    theme: StemWordChainTheme,
    word: string,
    authorId: string,
  ): Promise<boolean | undefined> {
    if (theme.words.includes(word)) {
      return true;
    }

    const cacheKey = `${theme.name}:${word}`;
    const cachedResult = this.themeValidationCache.get(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    if (!this.dependencies.themeValidator) {
      return false;
    }

    if (!this.canRequestThemeValidation(authorId)) {
      this.dependencies.logger.debug(
        { theme: theme.name, word, userId: authorId },
        'STEM word chain theme validation was rate limited; keeping the round open',
      );
      return undefined;
    }

    try {
      const result = await this.dependencies.themeValidator.isWordInTheme(theme.name, word);
      this.cacheThemeValidation(cacheKey, result);
      return result;
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, theme: theme.name, word },
        'STEM word chain theme validation could not be completed; keeping the round open',
      );
      return undefined;
    }
  }

  private queueWordDefinition(
    message: StemWordChainMessage,
    theme: StemWordChainTheme,
    word: string,
  ): void {
    const next = this.definitionQueue
      .catch(() => undefined)
      .then(async () => {
        const definition = await this.getWordDefinition(theme, word, message.authorId);
        if (!definition) {
          return;
        }

        try {
          await message.reply(`📖 **${word}** — ${definition}`);
        } catch (error: unknown) {
          this.dependencies.logger.warn(
            { err: error, channelId: message.channelId, messageId: message.id, word },
            'STEM word chain definition reply could not be sent',
          );
        }
      });
    this.definitionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    void next;
  }

  private async getWordDefinition(
    theme: StemWordChainTheme,
    word: string,
    authorId: string,
  ): Promise<string | undefined> {
    const cachedDefinition = this.wordDefinitionCache.get(word);
    if (cachedDefinition) {
      return cachedDefinition;
    }

    if (
      !this.dependencies.themeValidator?.getWordDefinition ||
      !this.canRequestWordDefinition(authorId)
    ) {
      return undefined;
    }

    try {
      const definition = (
        await this.dependencies.themeValidator.getWordDefinition(theme.name, word)
      ).trim();
      if (!definition) {
        return undefined;
      }

      this.cacheWordDefinition(word, definition);
      return definition;
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, theme: theme.name, word },
        'STEM word chain definition could not be generated',
      );
      return undefined;
    }
  }

  private canRequestThemeValidation(authorId: string): boolean {
    const now = Date.now();
    const lastRequestedAt = this.lastThemeValidationAt.get(authorId);
    if (lastRequestedAt && now - lastRequestedAt < THEME_VALIDATION_USER_COOLDOWN_MS) {
      return false;
    }

    if (now - this.themeValidationWindowStartedAt >= THEME_VALIDATION_GLOBAL_WINDOW_MS) {
      this.themeValidationWindowStartedAt = now;
      this.themeValidationWindowRequestCount = 0;
    }

    if (this.themeValidationWindowRequestCount >= THEME_VALIDATION_GLOBAL_LIMIT) {
      return false;
    }

    this.lastThemeValidationAt.set(authorId, now);
    this.themeValidationWindowRequestCount += 1;
    return true;
  }

  private cacheThemeValidation(cacheKey: string, result: boolean): void {
    if (this.themeValidationCache.size >= MAX_THEME_VALIDATION_CACHE_ENTRIES) {
      const oldestKey = this.themeValidationCache.keys().next().value;
      if (oldestKey) {
        this.themeValidationCache.delete(oldestKey);
      }
    }
    this.themeValidationCache.set(cacheKey, result);
  }

  private canRequestWordDefinition(authorId: string): boolean {
    const now = Date.now();
    const lastRequestedAt = this.lastWordDefinitionAt.get(authorId);
    if (lastRequestedAt && now - lastRequestedAt < WORD_DEFINITION_USER_COOLDOWN_MS) {
      return false;
    }

    if (now - this.wordDefinitionWindowStartedAt >= WORD_DEFINITION_GLOBAL_WINDOW_MS) {
      this.wordDefinitionWindowStartedAt = now;
      this.wordDefinitionWindowRequestCount = 0;
    }

    if (this.wordDefinitionWindowRequestCount >= WORD_DEFINITION_GLOBAL_LIMIT) {
      return false;
    }

    this.lastWordDefinitionAt.set(authorId, now);
    this.wordDefinitionWindowRequestCount += 1;
    return true;
  }

  private cacheWordDefinition(word: string, definition: string): void {
    if (this.wordDefinitionCache.size >= MAX_WORD_DEFINITION_CACHE_ENTRIES) {
      const oldestWord = this.wordDefinitionCache.keys().next().value;
      if (oldestWord) {
        this.wordDefinitionCache.delete(oldestWord);
      }
    }
    this.wordDefinitionCache.set(word, definition);
  }

  private async publishRound(
    rootState: JsonState,
    state: StemWordChainState,
    leadIn?: string,
  ): Promise<void> {
    const theme = getTheme(state.themeIndex);
    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      formatStemWordChainRound(theme, state.roundNumber, leadIn),
    );
    state.promptMessageId = messageId;
    writeStemWordChainState(rootState, state);
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      {
        channelId: this.dependencies.config.channelId,
        messageId,
        roundNumber: state.roundNumber,
        theme: theme.name,
      },
      'STEM word chain round posted',
    );
  }

  private async recordGameParticipation(message: StemWordChainMessage): Promise<void> {
    try {
      await this.dependencies.userLevels?.recordGameParticipation(message.authorId);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        {
          err: error,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.authorId,
        },
        'STEM word chain game XP could not be recorded',
      );
    }
  }

  private async react(message: StemWordChainMessage, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'STEM word chain reaction could not be added',
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
    return await next;
  }
}

export function createStemWordChainService(
  dependencies: StemWordChainServiceDependencies,
): StemWordChainService {
  return new PersistentStemWordChainService(dependencies);
}

export function formatStemWordChainRound(
  theme: StemWordChainTheme,
  roundNumber: number,
  leadIn?: string,
): string {
  return [
    leadIn,
    `🔗 **Word Chain ${roundNumber}**`,
    `Theme: **${theme.name}**`,
    'Start with any word that fits the theme. Each next word must start with the last letter of the previous word.',
    'A word outside the theme or the wrong starting letter ends the round and changes the theme.',
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}

export function normalizeWordChainWord(value: string): string | undefined {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase();
  return /^[a-z]+$/.test(normalized) ? normalized : undefined;
}

function readStemWordChainState(value: unknown): StemWordChainState {
  if (!isRecord(value) || value.version !== 1) {
    return createInitialState();
  }

  const themeIndex =
    typeof value.themeIndex === 'number' &&
    Number.isInteger(value.themeIndex) &&
    value.themeIndex >= 0 &&
    value.themeIndex < STEM_WORD_CHAIN_THEMES.length
      ? value.themeIndex
      : 0;
  const roundNumber =
    typeof value.roundNumber === 'number' &&
    Number.isSafeInteger(value.roundNumber) &&
    value.roundNumber > 0
      ? value.roundNumber
      : 1;
  const promptMessageId = typeof value.promptMessageId === 'string' ? value.promptMessageId : null;
  const lastWord =
    typeof value.lastWord === 'string' ? (normalizeWordChainWord(value.lastWord) ?? null) : null;
  const lastAuthorId = typeof value.lastAuthorId === 'string' ? value.lastAuthorId : null;
  const lastMessageId = typeof value.lastMessageId === 'string' ? value.lastMessageId : null;
  const streak = readNonNegativeInteger(value.streak);
  const bestStreak = readNonNegativeInteger(value.bestStreak);
  const roundStreaks = readMinigameScores(value.roundStreaks);
  const bestStreaks = readMinigameScores(value.bestStreaks);
  const processedMessageIds = Array.isArray(value.processedMessageIds)
    ? value.processedMessageIds
        .filter((id): id is string => typeof id === 'string')
        .slice(-MAX_PROCESSED_MESSAGE_IDS)
    : [];

  return {
    version: 1,
    themeIndex,
    roundNumber,
    promptMessageId,
    lastWord,
    lastAuthorId,
    lastMessageId,
    streak,
    bestStreak: Math.max(streak, bestStreak),
    roundStreaks,
    bestStreaks,
    processedMessageIds,
  };
}

function createInitialState(): StemWordChainState {
  return {
    version: 1,
    themeIndex: 0,
    roundNumber: 1,
    promptMessageId: null,
    lastWord: null,
    lastAuthorId: null,
    lastMessageId: null,
    streak: 0,
    bestStreak: 0,
    roundStreaks: {},
    bestStreaks: {},
    processedMessageIds: [],
  };
}

function writeStemWordChainState(rootState: JsonState, state: StemWordChainState): void {
  rootState[STATE_KEY] = state;
}

function getTheme(index: number): StemWordChainTheme {
  return STEM_WORD_CHAIN_THEMES[index] ?? STEM_WORD_CHAIN_THEMES[0]!;
}

function rememberMessageId(messageIds: readonly string[], messageId: string): string[] {
  return [...messageIds.filter((id) => id !== messageId), messageId].slice(
    -MAX_PROCESSED_MESSAGE_IDS,
  );
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
