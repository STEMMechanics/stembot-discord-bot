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
  react(emoji: string): Promise<void>;
  reply(content: string): Promise<void>;
}

export interface CountingChainService {
  handleMessage(message: CountingChainMessage): Promise<void>;
}

export interface CountingChainServiceDependencies {
  config: CountingChainConfig;
  recognizer: NumberRecognizer;
  state: StateStore<JsonState>;
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
  clock?: () => Date;
}

interface CountingChainGameState {
  expectedNumber: number;
  lastAuthorId: string | null;
  lastMessageId: string | null;
  updatedAt: string;
}

interface CountingChainState {
  version: 1;
  games: Record<string, CountingChainGameState>;
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

  public constructor(private readonly dependencies: CountingChainServiceDependencies) {
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
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

  private async processMessage(message: CountingChainMessage): Promise<void> {
    const attachment = selectImageAttachment(message.attachments);
    if (!attachment) {
      return;
    }

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
      return;
    }

    if (recognizedNumber === null) {
      await this.giveFeedback(
        message,
        RECOGNITION_FAILURE_REACTION,
        'I could not read that image. Please try again.',
      );
      return;
    }

    const rootState = await this.dependencies.state.load();
    const state = readCountingChainState(rootState[STATE_KEY]);
    const game = state.games[message.channelId] ?? createInitialGameState(this.currentTime());
    const passes =
      recognizedNumber === game.expectedNumber && message.authorId !== game.lastAuthorId;

    if (passes) {
      state.games[message.channelId] = {
        expectedNumber: recognizedNumber + 1,
        lastAuthorId: message.authorId,
        lastMessageId: message.id,
        updatedAt: this.currentTime().toISOString(),
      };
      rootState[STATE_KEY] = state;
      await this.dependencies.state.save(rootState);
      await this.react(message, PASS_REACTION);
      return;
    }

    state.games[message.channelId] = createInitialGameState(this.currentTime());
    rootState[STATE_KEY] = state;
    await this.dependencies.state.save(rootState);
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
    try {
      await message.react(emoji);
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId: message.channelId, messageId: message.id, emoji },
        'Counting chain reaction could not be added',
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

function readCountingChainState(value: unknown): CountingChainState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.games)) {
    return { version: 1, games: {} };
  }

  const games: Record<string, CountingChainGameState> = {};
  for (const [channelId, candidate] of Object.entries(value.games)) {
    if (!isRecord(candidate)) {
      continue;
    }

    const expectedNumber = candidate.expectedNumber;
    const lastAuthorId = candidate.lastAuthorId;
    const lastMessageId = candidate.lastMessageId;
    const updatedAt = candidate.updatedAt;
    if (
      typeof expectedNumber === 'number' &&
      Number.isSafeInteger(expectedNumber) &&
      expectedNumber > 0 &&
      (typeof lastAuthorId === 'string' || lastAuthorId === null) &&
      (typeof lastMessageId === 'string' || lastMessageId === null) &&
      typeof updatedAt === 'string'
    ) {
      games[channelId] = { expectedNumber, lastAuthorId, lastMessageId, updatedAt };
    }
  }

  return { version: 1, games };
}

function createInitialGameState(now: Date): CountingChainGameState {
  return {
    expectedNumber: 1,
    lastAuthorId: null,
    lastMessageId: null,
    updatedAt: now.toISOString(),
  };
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
