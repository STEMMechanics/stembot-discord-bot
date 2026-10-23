import type { StemAskAnswerer } from '../integrations/openai-ask.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface StemAskConfig {
  enabled: boolean;
  maxQuestionLength: number;
  userCooldownMs: number;
  userDailyLimit: number;
  globalDailyLimit: number;
}

export interface StemAskMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  question: string;
  reply(content: string): Promise<void>;
}

export interface StemAskService {
  handleMessage(message: StemAskMessage): Promise<void>;
}

interface StemAskState {
  version: 1;
  day: string;
  totalRequests: number;
  userRequests: Record<string, number>;
  lastAskedAt: Record<string, string>;
  processedMessageIds: string[];
}

interface StemAskServiceDependencies {
  config: StemAskConfig;
  answerer: StemAskAnswerer;
  state: StateStore<JsonState>;
  logger: AppLogger;
  clock?: () => Date;
  random?: () => number;
}

const STATE_KEY = 'stemAsk';
const MAX_PROCESSED_MESSAGE_IDS = 500;
const MAX_DISCORD_MESSAGE_LENGTH = 1900;
const RATE_LIMIT_RESPONSES = [
  'Hey, slow down — I’m not paid to work this hard. Try again in a bit.',
  'My tiny science brain needs a breather. Give it a moment, then try again.',
  'The lab is at capacity right now. Let the electrons settle and try again later.',
  'Quota reached. Even robots need a coffee break.',
] as const;

export class PersistentStemAskService implements StemAskService {
  private readonly currentTime: () => Date;
  private readonly random: () => number;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: StemAskServiceDependencies) {
    this.currentTime = dependencies.clock ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
  }

  public async handleMessage(message: StemAskMessage): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    if (message.authorIsBot) {
      return;
    }

    const question = message.question.trim();
    if (question.length === 0 || question.length > this.dependencies.config.maxQuestionLength) {
      this.dependencies.logger.debug(
        {
          channelId: message.channelId,
          messageId: message.id,
          questionLength: question.length,
          maxQuestionLength: this.dependencies.config.maxQuestionLength,
        },
        'STEM ask message was ignored because its question length was invalid',
      );
      return;
    }

    await this.enqueue(() => this.processMessage(message, question));
  }

  private async processMessage(message: StemAskMessage, question: string): Promise<void> {
    const now = this.currentTime();
    const day = getDayKey(now);
    const rootState = await this.dependencies.state.load();
    const state = readStemAskState(rootState[STATE_KEY], day);

    if (state.processedMessageIds.includes(message.id)) {
      return;
    }

    const userRequestCount = state.userRequests[message.authorId] ?? 0;
    if (state.totalRequests >= this.dependencies.config.globalDailyLimit) {
      await this.respondToRateLimit(message, 'global daily limit');
      return;
    }

    if (userRequestCount >= this.dependencies.config.userDailyLimit) {
      await this.respondToRateLimit(message, 'user daily limit');
      return;
    }

    const lastAskedAt = state.lastAskedAt[message.authorId];
    if (
      lastAskedAt &&
      Number.isFinite(Date.parse(lastAskedAt)) &&
      now.getTime() - Date.parse(lastAskedAt) < this.dependencies.config.userCooldownMs
    ) {
      await this.respondToRateLimit(message, 'user cooldown');
      return;
    }

    state.totalRequests += 1;
    state.userRequests[message.authorId] = userRequestCount + 1;
    state.lastAskedAt[message.authorId] = now.toISOString();
    state.processedMessageIds = rememberMessageId(state.processedMessageIds, message.id);
    writeStemAskState(rootState, state);
    await this.dependencies.state.save(rootState);

    let answer: string;
    try {
      answer = await this.dependencies.answerer.answer(question);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'STEM ask question could not be answered',
      );
      await this.replySafely(message, "I couldn't answer that right now. Please try again later.");
      return;
    }

    await this.replySafely(message, limitDiscordMessage(answer));
    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        userId: message.authorId,
        dailyRequestCount: state.userRequests[message.authorId],
        totalDailyRequests: state.totalRequests,
      },
      'STEM ask question answered',
    );
  }

  private async replySafely(message: StemAskMessage, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'STEM ask Discord reply could not be sent',
      );
    }
  }

  private async respondToRateLimit(message: StemAskMessage, limit: string): Promise<void> {
    this.dependencies.logger.info(
      { channelId: message.channelId, messageId: message.id, userId: message.authorId, limit },
      'STEM ask question was rate limited',
    );
    const randomValue = this.random();
    const responseIndex = Math.min(
      RATE_LIMIT_RESPONSES.length - 1,
      Math.max(
        0,
        Math.floor((Number.isFinite(randomValue) ? randomValue : 0) * RATE_LIMIT_RESPONSES.length),
      ),
    );
    const response = RATE_LIMIT_RESPONSES[responseIndex] ?? 'Please try again later.';
    await this.replySafely(message, response);
  }

  private isEnabled(): boolean {
    return this.dependencies.config.enabled;
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

export function createStemAskService(dependencies: StemAskServiceDependencies): StemAskService {
  return new PersistentStemAskService(dependencies);
}

function readStemAskState(value: unknown, day: string): StemAskState {
  if (!isRecord(value) || value.version !== 1 || value.day !== day) {
    return createInitialState(day);
  }

  const userRequests: Record<string, number> = {};
  if (isRecord(value.userRequests)) {
    for (const [userId, requestCount] of Object.entries(value.userRequests)) {
      if (
        typeof requestCount === 'number' &&
        Number.isSafeInteger(requestCount) &&
        requestCount >= 0
      ) {
        userRequests[userId] = requestCount;
      }
    }
  }

  const lastAskedAt: Record<string, string> = {};
  if (isRecord(value.lastAskedAt)) {
    for (const [userId, timestamp] of Object.entries(value.lastAskedAt)) {
      if (typeof timestamp === 'string') {
        lastAskedAt[userId] = timestamp;
      }
    }
  }

  const totalRequests =
    typeof value.totalRequests === 'number' &&
    Number.isSafeInteger(value.totalRequests) &&
    value.totalRequests >= 0
      ? value.totalRequests
      : 0;
  const processedMessageIds = Array.isArray(value.processedMessageIds)
    ? value.processedMessageIds
        .filter((id): id is string => typeof id === 'string')
        .slice(-MAX_PROCESSED_MESSAGE_IDS)
    : [];

  return { version: 1, day, totalRequests, userRequests, lastAskedAt, processedMessageIds };
}

function createInitialState(day: string): StemAskState {
  return {
    version: 1,
    day,
    totalRequests: 0,
    userRequests: {},
    lastAskedAt: {},
    processedMessageIds: [],
  };
}

function writeStemAskState(rootState: JsonState, state: StemAskState): void {
  rootState[STATE_KEY] = state;
}

function rememberMessageId(messageIds: readonly string[], messageId: string): string[] {
  return [...messageIds.filter((id) => id !== messageId), messageId].slice(
    -MAX_PROCESSED_MESSAGE_IDS,
  );
}

function limitDiscordMessage(value: string): string {
  const answer = value.trim();
  if (answer.length <= MAX_DISCORD_MESSAGE_LENGTH) {
    return answer;
  }

  return `${answer.slice(0, MAX_DISCORD_MESSAGE_LENGTH - 1).trimEnd()}…`;
}

function getDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
