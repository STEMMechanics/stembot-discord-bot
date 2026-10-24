import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface ChatDiscordBridgeConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  bearerToken?: string;
  channelId?: string;
  maxBodyBytes: number;
}

export interface ChatDiscordBridgePublisher {
  send(channelId: string, content: string): Promise<string>;
}

export interface ChatDiscordBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ChatDiscordBridgeDependencies {
  config: ChatDiscordBridgeConfig;
  publisher: ChatDiscordBridgePublisher;
  state: StateStore<JsonState>;
  logger: AppLogger;
  serverFactory?: typeof createServer;
}

interface MinecraftChatEvent {
  event: 'minecraft.chat';
  event_id: string;
  player: {
    name: string;
    uuid?: string | undefined;
  };
  message: string;
}

interface ChatDiscordBridgeState {
  version: 1;
  processedEventIds: string[];
}

const MAX_PROCESSED_EVENT_IDS = 1000;
const minecraftChatEventSchema = z.object({
  event: z.literal('minecraft.chat'),
  event_id: z.string().trim().min(1).max(200),
  occurred_at: z.string().trim().max(100).optional(),
  player: z.object({
    name: z.string().trim().min(1).max(80),
    uuid: z.string().trim().max(100).optional(),
  }),
  message: z.string().trim().min(1).max(1800),
});

export class HttpChatDiscordBridge implements ChatDiscordBridge {
  private readonly serverFactory: typeof createServer;
  private server: Server | undefined;
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: ChatDiscordBridgeDependencies) {
    this.serverFactory = dependencies.serverFactory ?? createServer;
  }

  public async start(): Promise<void> {
    if (!this.dependencies.config.enabled || this.server) {
      return;
    }

    const server = this.serverFactory((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        this.dependencies.logger.info(
          {
            host: this.dependencies.config.host,
            port: this.dependencies.config.port,
            path: this.dependencies.config.path,
            channelId: this.dependencies.config.channelId,
          },
          'Minecraft chat Discord bridge listening',
        );
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.dependencies.config.port, this.dependencies.config.host);
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.dependencies.logger.info('Minecraft chat Discord bridge stopped');
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url?.split('?')[0] !== this.dependencies.config.path) {
      request.resume();
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.method !== 'POST') {
      request.resume();
      response.setHeader('Allow', 'POST');
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    if (!hasBearerToken(request.headers.authorization, this.dependencies.config.bearerToken)) {
      request.resume();
      writeJson(response, 401, { error: 'unauthorized' });
      return;
    }

    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !contentType.toLocaleLowerCase().startsWith('application/json')
    ) {
      request.resume();
      writeJson(response, 415, { error: 'content_type_must_be_application_json' });
      return;
    }

    let body: string;
    try {
      body = await readRequestBody(request, this.dependencies.config.maxBodyBytes);
    } catch (error: unknown) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(response, 413, { error: 'request_body_too_large' });
        return;
      }

      this.dependencies.logger.warn({ err: error }, 'Minecraft chat bridge request body failed');
      writeJson(response, 400, { error: 'invalid_request_body' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      writeJson(response, 400, { error: 'invalid_json' });
      return;
    }

    const result = minecraftChatEventSchema.safeParse(parsed);
    if (!result.success) {
      writeJson(response, 400, { error: 'invalid_minecraft_chat_event' });
      return;
    }

    const headerEventId = readHeaderValue(request.headers['x-stemcraft-event-id']);
    if (headerEventId && headerEventId !== result.data.event_id) {
      writeJson(response, 400, { error: 'event_id_mismatch' });
      return;
    }

    try {
      const duplicate = await this.enqueue(() => this.publishEvent(result.data));
      writeJson(response, 200, { accepted: true, duplicate });
    } catch (error: unknown) {
      this.dependencies.logger.error(
        { err: error },
        'Minecraft chat bridge could not publish event',
      );
      writeJson(response, 502, { error: 'discord_publish_failed' });
    }
  }

  private async publishEvent(event: MinecraftChatEvent): Promise<boolean> {
    const rootState = await this.dependencies.state.load();
    const state = readBridgeState(rootState.chatDiscordBridge);
    if (state.processedEventIds.includes(event.event_id)) {
      this.dependencies.logger.info(
        { eventId: event.event_id },
        'Duplicate Minecraft chat event ignored',
      );
      return true;
    }

    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      `⛏️ **${event.player.name}**: ${event.message}`,
    );
    state.processedEventIds = [...state.processedEventIds, event.event_id].slice(
      -MAX_PROCESSED_EVENT_IDS,
    );
    rootState.chatDiscordBridge = state;
    await this.dependencies.state.save(rootState);
    this.dependencies.logger.info(
      {
        eventId: event.event_id,
        messageId,
        player: event.player.name,
        messageLength: event.message.length,
      },
      'Minecraft chat event published to Discord',
    );
    return false;
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

export function createChatDiscordBridge(
  dependencies: ChatDiscordBridgeDependencies,
): ChatDiscordBridge {
  return new HttpChatDiscordBridge(dependencies);
}

export class RequestBodyTooLargeError extends Error {
  public constructor() {
    super('Request body is too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > maxBytes) {
        request.resume();
        fail(new RequestBodyTooLargeError());
        return;
      }

      chunks.push(buffer);
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', (error) => fail(error));
  });
}

function hasBearerToken(
  value: string | string[] | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || typeof value !== 'string' || !value.startsWith('Bearer ')) {
    return false;
  }

  const actual = Buffer.from(value.slice('Bearer '.length), 'utf8');
  const required = Buffer.from(expected, 'utf8');
  return actual.length === required.length && timingSafeEqual(actual, required);
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function readBridgeState(value: unknown): ChatDiscordBridgeState {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'version' in value &&
    value.version === 1 &&
    'processedEventIds' in value &&
    Array.isArray(value.processedEventIds)
  ) {
    return {
      version: 1,
      processedEventIds: value.processedEventIds
        .filter((eventId): eventId is string => typeof eventId === 'string')
        .slice(-MAX_PROCESSED_EVENT_IDS),
    };
  }

  return { version: 1, processedEventIds: [] };
}
