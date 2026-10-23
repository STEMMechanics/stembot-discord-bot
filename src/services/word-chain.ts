import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';
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
}

export interface StemWordChainPublisher {
  send(channelId: string, content: string): Promise<string>;
}

export interface StemWordChainService {
  initialize(): Promise<void>;
  ensureRound(): Promise<void>;
  handleMessage(message: StemWordChainMessage): Promise<void>;
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
  processedMessageIds: string[];
}

interface StemWordChainServiceDependencies {
  config: StemWordChainConfig;
  publisher: StemWordChainPublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  userLevels?: UserLevelService;
}

const STATE_KEY = 'stemWordChain';
const PASS_REACTION = '✅';
const FAILURE_REACTION = '❌';
const MAX_PROCESSED_MESSAGE_IDS = 500;

export class PersistentStemWordChainService implements StemWordChainService {
  private eventQueue: Promise<void> = Promise.resolve();

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
    const valid =
      word !== undefined &&
      theme.words.includes(word) &&
      (!state.lastWord || (expectedLetter !== undefined && word.startsWith(expectedLetter)));

    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    if (valid && word) {
      state.lastWord = word;
      state.lastAuthorId = message.authorId;
      state.lastMessageId = message.id;
      state.streak += 1;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
      writeStemWordChainState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.react(message, PASS_REACTION);
      await this.recordGameParticipation(message);
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

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.eventQueue.catch(() => undefined).then(work);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
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
