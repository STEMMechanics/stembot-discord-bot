import type { NumberImage, NumberRecognizer } from '../integrations/openai.js';
import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface CountingChainConfig {
  enabled: boolean;
  channelId?: string;
  maxAttachmentBytes: number;
}

export interface CountingChainAttachment {
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
}

export interface CountingChainMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  attachments: readonly CountingChainAttachment[];
  botReactionEmojis?: readonly string[];
  react(emoji: string): Promise<void>;
  reply(content: string): Promise<void>;
}

export interface CountingChainHistoryMessage extends CountingChainMessage {
  content: string;
  botReactionEmojis: readonly string[];
}

export type CountingChainHistoryProvider = () => Promise<readonly CountingChainHistoryMessage[]>;

export interface CountingChainGameStatus {
  expectedNumber: number;
  lastAuthorId: string | null;
  lastMessageId: string | null;
  updatedAt: string;
  highScore: number;
  highScoreAt: string | null;
  lastRound: number;
  lastRoundAt: string | null;
  lastRoundReason: string | null;
}

export interface CountingChainInfoPublisher {
  update(status: CountingChainGameStatus, messageId?: string): Promise<string | undefined>;
}

export interface CountingChainService {
  handleMessage(message: CountingChainMessage): Promise<void>;
  initialize(
    historyProvider: CountingChainHistoryProvider,
    infoPublisher?: CountingChainInfoPublisher,
  ): Promise<void>;
}

export interface CountingChainServiceDependencies {
  config: CountingChainConfig;
  recognizer: NumberRecognizer;
  state: StateStore<JsonState>;
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
  clock?: () => Date;
}

type CountingChainGameState = CountingChainGameStatus & {
  lastProcessedMessageId: string | null;
};

interface CountingChainState {
  version: 1;
  game: CountingChainGameState | null;
  infoMessageId: string | null;
  historyRecoveryPending: boolean;
}

const STATE_KEY = 'countingChain';
const PASS_REACTION = '👍';
const RULE_FAILURE_REACTION = '❌';
const RECOGNITION_FAILURE_REACTION = '⚠️';
const ALLOWED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

export class PersistentCountingChainService implements CountingChainService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly fetchImplementation: typeof fetch;
  private initializationPromise: Promise<void> | undefined;
  private infoPublisher: CountingChainInfoPublisher | undefined;

  public constructor(private readonly dependencies: CountingChainServiceDependencies) {
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
  }

  public initialize(
    historyProvider: CountingChainHistoryProvider,
    infoPublisher?: CountingChainInfoPublisher,
  ): Promise<void> {
    if (infoPublisher) {
      this.infoPublisher = infoPublisher;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = (async (): Promise<void> => {
        try {
          await this.recoverMissingState(historyProvider);
        } catch (error: unknown) {
          this.dependencies.logger.warn(
            { err: error, channelId: this.dependencies.config.channelId },
            'Counting chain startup reconciliation failed; retrying on next startup',
          );
        }

        await this.publishInfo();
      })();
    }

    return this.initializationPromise;
  }

  public handleMessage(message: CountingChainMessage): Promise<void> {
    if (
      !this.dependencies.config.enabled ||
      !this.dependencies.config.channelId ||
      message.channelId !== this.dependencies.config.channelId ||
      message.authorIsBot
    ) {
      return Promise.resolve();
    }

    const previous = this.queues.get(message.channelId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.initializationPromise)
      .then(() => this.processMessage(message))
      .catch((error: unknown) => {
        this.dependencies.logger.error(
          { err: error, channelId: message.channelId, messageId: message.id },
          'Counting chain message processing failed',
        );
      })
      .finally(() => {
        if (this.queues.get(message.channelId) === next) {
          this.queues.delete(message.channelId);
        }
      });

    this.queues.set(message.channelId, next);
    return next;
  }

  private async recoverMissingState(historyProvider: CountingChainHistoryProvider): Promise<void> {
    const channelId = this.dependencies.config.channelId;
    if (!this.dependencies.config.enabled || !channelId) {
      return;
    }

    const rootState = await this.dependencies.state.load();
    const rawCountingChainState = rootState[STATE_KEY];
    const state = readCountingChainState(rawCountingChainState, channelId);

    this.dependencies.logger.info(
      {
        channelId,
        hasPersistedGame: state.game !== null,
        historyRecoveryPending: state.historyRecoveryPending,
      },
      'Counting chain startup reconciliation checking Discord history',
    );
    let history: readonly CountingChainHistoryMessage[];
    try {
      history = await historyProvider();
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId },
        'Counting chain Discord history could not be read; retaining state for retry',
      );
      await saveHistoryRecoveryPending(
        rootState,
        state,
        this.currentTime(),
        this.dependencies.state,
      );
      return;
    }

    this.dependencies.logger.info(
      { channelId, historyCount: history.length },
      'Counting chain Discord history fetched for startup recovery',
    );
    const orderedHistory = sortHistoryNewestFirst(history);
    const newestMessage = orderedHistory[0];
    this.dependencies.logger.info(
      {
        channelId,
        newestMessageId: newestMessage?.id,
        newestMessageAuthorIsBot: newestMessage?.authorIsBot,
        newestMessageAttachmentCount: newestMessage?.attachments.length,
      },
      'Counting chain history newest message identified',
    );

    const checkpointMessageId = state.game?.lastProcessedMessageId ?? state.game?.lastMessageId;
    if (checkpointMessageId && isDiscordSnowflake(checkpointMessageId)) {
      await this.reconcileHistoryAfterCheckpoint(orderedHistory, checkpointMessageId);
      return;
    }

    const latestMessage = findLatestRelevantHistoryMessage(orderedHistory);
    this.dependencies.logger.info(
      { channelId, selectedMessageId: latestMessage?.id },
      'Counting chain history candidate selected for initial recovery',
    );
    if (!latestMessage || isCountingChainFailureMessage(latestMessage)) {
      this.dependencies.logger.info(
        {
          channelId,
          historyCount: history.length,
          relevantMessageId: latestMessage?.id,
          historyOutcome: latestMessage ? 'failure-marker' : 'no-relevant-image',
        },
        'Counting chain history did not contain an accepted image; starting at one',
      );
      await saveInitialState(rootState, state, this.currentTime(), this.dependencies.state);
      return;
    }

    const attachment = selectImageAttachment(latestMessage.attachments);
    if (!attachment) {
      await saveInitialState(rootState, state, this.currentTime(), this.dependencies.state);
      return;
    }

    try {
      const image = await this.downloadImage(attachment);
      const recognizedNumber = await this.dependencies.recognizer.recognizeNumber(image);
      if (recognizedNumber === null) {
        throw new Error('Counting chain history image could not be read');
      }

      state.game = {
        expectedNumber: recognizedNumber + 1,
        lastAuthorId: latestMessage.authorId,
        lastMessageId: latestMessage.id,
        updatedAt: this.currentTime().toISOString(),
        highScore: recognizedNumber,
        highScoreAt: this.currentTime().toISOString(),
        lastRound: recognizedNumber,
        lastRoundAt: this.currentTime().toISOString(),
        lastRoundReason: null,
        lastProcessedMessageId: latestMessage.id,
      };
      state.historyRecoveryPending = false;
      writeCountingChainState(rootState, state);
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        {
          channelId,
          messageId: latestMessage.id,
          authorId: latestMessage.authorId,
          recognizedNumber,
          expectedNumber: recognizedNumber + 1,
        },
        'Counting chain state recovered from Discord history',
      );
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId, messageId: latestMessage.id },
        'Counting chain history image could not be read; silently resetting',
      );
      await saveInitialState(rootState, state, this.currentTime(), this.dependencies.state);
    }
  }

  private async reconcileHistoryAfterCheckpoint(
    history: readonly CountingChainHistoryMessage[],
    checkpointMessageId: string,
  ): Promise<void> {
    const pendingMessages = sortHistoryOldestFirst(history).filter(
      (message) =>
        !message.authorIsBot &&
        isDiscordMessageAfter(message.id, checkpointMessageId) &&
        selectImageAttachment(message.attachments) !== undefined,
    );

    this.dependencies.logger.info(
      {
        channelId: this.dependencies.config.channelId,
        checkpointMessageId,
        pendingImageCount: pendingMessages.length,
        newestPendingMessageId: pendingMessages.at(-1)?.id,
      },
      'Counting chain startup reconciliation found pending images',
    );

    try {
      for (const message of pendingMessages) {
        await this.processMessage(message);
      }

      const latestRootState = await this.dependencies.state.load();
      const latestState = readCountingChainState(
        latestRootState[STATE_KEY],
        this.dependencies.config.channelId,
      );
      latestState.historyRecoveryPending = false;
      writeCountingChainState(latestRootState, latestState);
      await this.dependencies.state.save(latestRootState);
      this.dependencies.logger.info(
        {
          channelId: this.dependencies.config.channelId,
          checkpointMessageId,
          processedImageCount: pendingMessages.length,
        },
        'Counting chain startup reconciliation completed',
      );
    } catch (error: unknown) {
      const latestRootState = await this.dependencies.state.load();
      const latestState = readCountingChainState(
        latestRootState[STATE_KEY],
        this.dependencies.config.channelId,
      );
      latestState.historyRecoveryPending = true;
      writeCountingChainState(latestRootState, latestState);
      await this.dependencies.state.save(latestRootState);
      throw error;
    }
  }

  private async processMessage(message: CountingChainMessage): Promise<void> {
    const attachment = selectImageAttachment(message.attachments);
    if (!attachment) {
      this.dependencies.logger.debug(
        { channelId: message.channelId, messageId: message.id },
        'Counting chain message had no supported image attachment',
      );
      return;
    }

    this.dependencies.logger.info(
      {
        channelId: message.channelId,
        messageId: message.id,
        contentType: attachment.contentType,
        size: attachment.size,
      },
      'Counting chain image received',
    );

    let recognizedNumber: number | null;
    try {
      const image = await this.downloadImage(attachment);
      recognizedNumber = await this.dependencies.recognizer.recognizeNumber(image);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'Counting chain image could not be read; game state unchanged',
      );
      await this.giveFeedback(
        message,
        RECOGNITION_FAILURE_REACTION,
        'I could not read that image. Please try again.',
      );
      await this.markMessageProcessed(message);
      return;
    }

    if (recognizedNumber === null) {
      await this.giveFeedback(
        message,
        RECOGNITION_FAILURE_REACTION,
        'I could not read that image. Please try again.',
      );
      await this.markMessageProcessed(message);
      return;
    }

    const rootState = await this.dependencies.state.load();
    const state = readCountingChainState(rootState[STATE_KEY], message.channelId);
    const game = state.game ?? createInitialGameState(this.currentTime());
    const passes =
      recognizedNumber === game.expectedNumber && message.authorId !== game.lastAuthorId;

    if (passes) {
      const now = this.currentTime();
      const highScore = Math.max(game.highScore, recognizedNumber);
      state.game = {
        expectedNumber: recognizedNumber + 1,
        lastAuthorId: message.authorId,
        lastMessageId: message.id,
        updatedAt: now.toISOString(),
        highScore,
        highScoreAt: recognizedNumber > game.highScore ? now.toISOString() : game.highScoreAt,
        lastRound: game.lastRound,
        lastRoundAt: game.lastRoundAt,
        lastRoundReason: game.lastRoundReason,
        lastProcessedMessageId: message.id,
      };
      writeCountingChainState(rootState, state);
      await this.dependencies.state.save(rootState);
      await this.publishInfo();
      await this.react(message, PASS_REACTION);
      return;
    }

    const now = this.currentTime();
    const roundScore = Math.max(0, game.expectedNumber - 1);
    const highScore = Math.max(game.highScore, roundScore);
    state.game = createInitialGameState(now, {
      highScore,
      highScoreAt: roundScore > game.highScore ? now.toISOString() : game.highScoreAt,
      lastRound: roundScore,
      lastRoundAt: now.toISOString(),
      lastRoundReason: message.authorId === game.lastAuthorId ? 'same-user' : 'wrong-number',
      lastProcessedMessageId: message.id,
    });
    writeCountingChainState(rootState, state);
    await this.dependencies.state.save(rootState);
    await this.publishInfo();
    await this.react(message, RULE_FAILURE_REACTION);
    await this.reply(
      message,
      'Counting chain over — the next number was not accepted. Starting again at 1.',
    );
  }

  private async downloadImage(attachment: CountingChainAttachment): Promise<NumberImage> {
    if (attachment.size && attachment.size > this.dependencies.config.maxAttachmentBytes) {
      throw new Error('Counting chain image exceeds the configured attachment limit');
    }

    const url = new URL(attachment.url);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error('Counting chain attachment URL is not a Discord CDN URL');
    }

    const response = await this.fetchImplementation(attachment.url, {
      headers: { Accept: 'image/gif, image/jpeg, image/png, image/webp' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Counting chain image request failed with HTTP ${response.status}`);
    }

    const responseContentType = normalizeContentType(response.headers.get('content-type'));
    const attachmentContentType = normalizeContentType(attachment.contentType);
    const contentType =
      (responseContentType && IMAGE_TYPES.has(responseContentType)
        ? responseContentType
        : undefined) ??
      (attachmentContentType && IMAGE_TYPES.has(attachmentContentType)
        ? attachmentContentType
        : undefined) ??
      contentTypeFromName(attachment.name);
    if (!contentType || !IMAGE_TYPES.has(contentType)) {
      throw new Error('Counting chain attachment is not a supported image');
    }

    const data = await readResponseBody(response, this.dependencies.config.maxAttachmentBytes);
    return { data, contentType };
  }

  private async react(message: CountingChainMessage, emoji: string): Promise<void> {
    if (message.botReactionEmojis?.includes(emoji)) {
      return;
    }

    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'Counting chain reaction could not be added',
      );
    }
  }

  private async markMessageProcessed(message: CountingChainMessage): Promise<void> {
    const rootState = await this.dependencies.state.load();
    const state = readCountingChainState(rootState[STATE_KEY], message.channelId);
    const game = state.game ?? createInitialGameState(this.currentTime());
    game.lastProcessedMessageId = message.id;
    game.updatedAt = this.currentTime().toISOString();
    state.game = game;
    writeCountingChainState(rootState, state);
    await this.dependencies.state.save(rootState);
  }

  private async publishInfo(): Promise<void> {
    const channelId = this.dependencies.config.channelId;
    if (!this.infoPublisher || !channelId) {
      return;
    }

    try {
      const rootState = await this.dependencies.state.load();
      const state = readCountingChainState(rootState[STATE_KEY], channelId);
      const game = state.game ?? createInitialGameState(this.currentTime());
      const infoMessageId = await this.infoPublisher.update(game, state.infoMessageId ?? undefined);
      if (infoMessageId && infoMessageId !== state.infoMessageId) {
        state.infoMessageId = infoMessageId;
        writeCountingChainState(rootState, state);
        await this.dependencies.state.save(rootState);
      }
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId },
        'Counting chain information message could not be updated',
      );
    }
  }

  private async giveFeedback(
    message: CountingChainMessage,
    emoji: string,
    content: string,
  ): Promise<void> {
    await this.react(message, emoji);
    await this.reply(message, content);
  }

  private async reply(message: CountingChainMessage, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id },
        'Counting chain feedback message could not be sent',
      );
    }
  }

  private currentTime(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }
}

export function createCountingChainService(
  dependencies: CountingChainServiceDependencies,
): CountingChainService {
  return new PersistentCountingChainService(dependencies);
}

async function saveInitialState(
  rootState: JsonState,
  state: CountingChainState,
  now: Date,
  stateStore: StateStore<JsonState>,
  historyRecoveryPending = false,
): Promise<void> {
  state.game = createInitialGameState(now);
  state.historyRecoveryPending = historyRecoveryPending;
  writeCountingChainState(rootState, state);
  await stateStore.save(rootState);
}

async function saveHistoryRecoveryPending(
  rootState: JsonState,
  state: CountingChainState,
  now: Date,
  stateStore: StateStore<JsonState>,
): Promise<void> {
  if (!state.game) {
    state.game = createInitialGameState(now);
  }
  state.historyRecoveryPending = true;
  writeCountingChainState(rootState, state);
  await stateStore.save(rootState);
}

function writeCountingChainState(rootState: JsonState, state: CountingChainState): void {
  rootState[STATE_KEY] = {
    version: state.version,
    infoMessageId: state.infoMessageId,
    ...(state.historyRecoveryPending ? { historyRecoveryPending: true } : {}),
    ...(state.game ?? {}),
  };
}

function findLatestRelevantHistoryMessage(
  history: readonly CountingChainHistoryMessage[],
): CountingChainHistoryMessage | undefined {
  for (const message of history) {
    if (message.authorIsBot) {
      if (isCountingChainFailureMessage(message)) {
        return message;
      }
      continue;
    }

    if (selectImageAttachment(message.attachments)) {
      return message;
    }
  }

  return undefined;
}

function sortHistoryNewestFirst(
  history: readonly CountingChainHistoryMessage[],
): CountingChainHistoryMessage[] {
  return [...history].sort(compareDiscordMessageIdsNewestFirst);
}

function sortHistoryOldestFirst(
  history: readonly CountingChainHistoryMessage[],
): CountingChainHistoryMessage[] {
  return sortHistoryNewestFirst(history).reverse();
}

function compareDiscordMessageIdsNewestFirst(
  left: CountingChainMessage,
  right: CountingChainMessage,
): number {
  return compareSnowflakeIdsNewestFirst(left.id, right.id);
}

function compareSnowflakeIdsNewestFirst(left: string, right: string): number {
  const leftIsSnowflake = /^\d+$/.test(left);
  const rightIsSnowflake = /^\d+$/.test(right);
  if (leftIsSnowflake && rightIsSnowflake) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
  }

  return 0;
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d+$/.test(value);
}

function isDiscordMessageAfter(messageId: string, checkpointMessageId: string): boolean {
  if (!isDiscordSnowflake(messageId) || !isDiscordSnowflake(checkpointMessageId)) {
    return false;
  }

  return BigInt(messageId) > BigInt(checkpointMessageId);
}

function isCountingChainFailureMessage(message: CountingChainHistoryMessage): boolean {
  if (
    message.content.startsWith('Counting chain over —') ||
    message.content.startsWith('I could not read that image.')
  ) {
    return true;
  }

  return message.botReactionEmojis.some(
    (emoji) => emoji === RULE_FAILURE_REACTION || emoji === RECOGNITION_FAILURE_REACTION,
  );
}

function readCountingChainState(value: unknown, channelId?: string): CountingChainState {
  if (!isRecord(value) || value.version !== 1) {
    return { version: 1, game: null, infoMessageId: null, historyRecoveryPending: false };
  }

  const currentGame = readGameState(value);
  const nestedGame = !currentGame ? readGameState(value.game) : undefined;
  const legacyGame =
    !currentGame && !nestedGame && isRecord(value.games)
      ? readGameState(
          channelId
            ? value.games[channelId]
            : Object.values(value.games).find((candidate) => isRecord(candidate)),
        )
      : undefined;

  return {
    version: 1,
    game: currentGame ?? nestedGame ?? legacyGame ?? null,
    infoMessageId: readNullableString(value.infoMessageId),
    historyRecoveryPending: value.historyRecoveryPending === true,
  };
}

function readGameState(value: unknown): CountingChainGameState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const expectedNumber = value.expectedNumber;
  const lastAuthorId = value.lastAuthorId;
  const lastMessageId = value.lastMessageId;
  const updatedAt = value.updatedAt;
  const lastProcessedMessageId = Object.prototype.hasOwnProperty.call(
    value,
    'lastProcessedMessageId',
  )
    ? readNullableString(value.lastProcessedMessageId)
    : readNullableString(lastMessageId);
  const legacyScore =
    typeof expectedNumber === 'number' && Number.isSafeInteger(expectedNumber)
      ? Math.max(0, expectedNumber - 1)
      : undefined;
  const highScore = readNonNegativeInteger(value.highScore, legacyScore);
  const lastRound = readNonNegativeInteger(value.lastRound, highScore);
  const highScoreAt = readNullableString(value.highScoreAt);
  const lastRoundAt = readNullableString(value.lastRoundAt);
  const lastRoundReason = readNullableString(value.lastRoundReason);
  if (
    typeof expectedNumber !== 'number' ||
    !Number.isSafeInteger(expectedNumber) ||
    expectedNumber <= 0 ||
    (typeof lastAuthorId !== 'string' && lastAuthorId !== null) ||
    (typeof lastMessageId !== 'string' && lastMessageId !== null) ||
    typeof updatedAt !== 'string'
  ) {
    return undefined;
  }

  return {
    expectedNumber,
    lastAuthorId,
    lastMessageId,
    updatedAt,
    highScore,
    highScoreAt,
    lastRound,
    lastRoundAt,
    lastRoundReason,
    lastProcessedMessageId,
  };
}

function createInitialGameState(
  now: Date,
  overrides: Partial<CountingChainGameState> = {},
): CountingChainGameState {
  return {
    expectedNumber: 1,
    lastAuthorId: null,
    lastMessageId: null,
    updatedAt: now.toISOString(),
    highScore: 0,
    highScoreAt: null,
    lastRound: 0,
    lastRoundAt: null,
    lastRoundReason: null,
    lastProcessedMessageId: null,
    ...overrides,
  };
}

function readNonNegativeInteger(value: unknown, fallback: number | undefined): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  return fallback !== undefined && Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 0;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' || value === null ? value : null;
}

function selectImageAttachment(
  attachments: readonly CountingChainAttachment[],
): CountingChainAttachment | undefined {
  return attachments.find((attachment) => {
    const contentType = normalizeContentType(attachment.contentType);
    return (
      (contentType && IMAGE_TYPES.has(contentType)) || Boolean(contentTypeFromName(attachment.name))
    );
  });
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  const contentType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return contentType || undefined;
}

function contentTypeFromName(name: string | undefined): string | undefined {
  const extension = name?.split('.').pop()?.toLowerCase();
  return {
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  }[extension ?? ''];
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error('Counting chain image exceeds the configured attachment limit');
  }

  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > maximumBytes) {
      throw new Error('Counting chain image exceeds the configured attachment limit');
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error('Counting chain image exceeds the configured attachment limit');
    }
    chunks.push(Buffer.from(result.value));
  }

  return Buffer.concat(chunks, totalBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
