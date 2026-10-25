import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { APIEmbed, MessageMentionOptions } from 'discord.js';
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

export interface ChatDiscordBridgeMessage {
  embeds: APIEmbed[];
  allowedMentions: MessageMentionOptions;
}

export interface ChatDiscordBridgePublisher {
  send(channelId: string, message: string | ChatDiscordBridgeMessage): Promise<string>;
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

const minecraftPlayerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  uuid: z.string().trim().max(100).optional(),
});
const minecraftEventBase = {
  event_id: z.string().trim().min(1).max(200),
  occurred_at: z.string().trim().max(100).optional(),
  server: z.string().trim().max(100).optional(),
  channel: z.string().trim().max(100).optional(),
};
const minecraftEventDataSchema = z.record(z.string(), z.unknown());

const minecraftEventSchema = z.discriminatedUnion('event', [
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.chat'),
    player: minecraftPlayerSchema,
    message: z.string().trim().min(1).max(1800),
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.player_join'),
    player: minecraftPlayerSchema,
    data: minecraftEventDataSchema.optional(),
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.player_quit'),
    player: minecraftPlayerSchema,
    data: minecraftEventDataSchema.optional(),
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.player_death'),
    player: minecraftPlayerSchema,
    data: minecraftEventDataSchema.optional(),
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.player_command'),
    player: minecraftPlayerSchema,
    data: z.object({
      command: z.string().trim().min(1).max(1800),
    }),
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.server_start'),
    data: minecraftEventDataSchema.optional(),
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.server_stop'),
    data: minecraftEventDataSchema.optional(),
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.minigame_start'),
    data: minecraftEventDataSchema,
  }),
  z.object({
    ...minecraftEventBase,
    event: z.literal('minecraft.minigame_end'),
    data: minecraftEventDataSchema,
  }),
]);

type MinecraftEvent = z.infer<typeof minecraftEventSchema>;
type MinecraftChatEvent = Extract<MinecraftEvent, { event: 'minecraft.chat' }>;
type MinecraftPlayerDeathEvent = Extract<MinecraftEvent, { event: 'minecraft.player_death' }>;
type MinecraftEmbedEvent = Exclude<MinecraftEvent, MinecraftChatEvent | MinecraftPlayerDeathEvent>;

interface ChatDiscordBridgeState {
  version: 1;
  processedEventIds: string[];
}

const MAX_PROCESSED_EVENT_IDS = 1000;
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
          'Minecraft Discord bridge listening',
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
    this.dependencies.logger.info('Minecraft Discord bridge stopped');
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestPath = normalizeHttpPath(request.url?.split('?')[0] ?? '');
    const configuredPath = normalizeHttpPath(this.dependencies.config.path);
    if (requestPath !== configuredPath) {
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
      writeJson(response, 415, {
        error: 'content_type_must_be_application_json',
      });
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

    const result = minecraftEventSchema.safeParse(parsed);
    if (!result.success) {
      writeJson(response, 400, { error: 'invalid_minecraft_event' });
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
        'Minecraft event bridge could not publish event',
      );
      writeJson(response, 502, { error: 'discord_publish_failed' });
    }
  }

  private async publishEvent(event: MinecraftEvent): Promise<boolean> {
    const rootState = await this.dependencies.state.load();
    const state = readBridgeState(rootState.chatDiscordBridge);
    if (state.processedEventIds.includes(event.event_id)) {
      this.dependencies.logger.info(
        { eventId: event.event_id },
        'Duplicate Minecraft event ignored',
      );
      return true;
    }

    const message =
      event.event === 'minecraft.chat'
        ? `${event.player.name} » ${event.message}`
        : event.event === 'minecraft.player_death'
          ? `💀 ${getMinecraftDeathMessage(event)}`
          : {
              embeds: [buildMinecraftEventEmbed(event)],
              allowedMentions: { parse: [] },
            };
    const messageId = await this.dependencies.publisher.send(
      this.dependencies.config.channelId!,
      message,
    );
    state.processedEventIds = [...state.processedEventIds, event.event_id].slice(
      -MAX_PROCESSED_EVENT_IDS,
    );
    rootState.chatDiscordBridge = state;
    await this.dependencies.state.save(rootState);
    if (event.event === 'minecraft.chat') {
      this.dependencies.logger.info(
        {
          eventId: event.event_id,
          messageId,
          player: event.player.name,
          messageLength: event.message.length,
        },
        'Minecraft chat event published to Discord',
      );
    } else if (event.event === 'minecraft.player_death') {
      this.dependencies.logger.info(
        {
          eventId: event.event_id,
          messageId,
          player: event.player.name,
          messageLength: asText(event.data?.message)?.length ?? 0,
        },
        'Minecraft death event published to Discord',
      );
    } else {
      this.dependencies.logger.info(
        { eventId: event.event_id, eventType: event.event, messageId },
        'Minecraft event embed published to Discord',
      );
    }
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

function buildMinecraftEventEmbed(event: MinecraftEmbedEvent): APIEmbed {
  if (event.event === 'minecraft.player_join' || event.event === 'minecraft.player_quit') {
    const joined = event.event === 'minecraft.player_join';
    return {
      color: joined ? 0x00ff00 : 0xff0000,
      author: {
        name: `${event.player.name} ${joined ? 'joined' : 'left'} the server`,
        icon_url: `https://mc-heads.net/avatar/${encodeURIComponent(event.player.name)}/64.png`,
      },
    };
  }

  const data: Record<string, unknown> = event.data ?? {};
  const fields: NonNullable<APIEmbed['fields']> = [];
  let title: string;
  let description: string;
  let color: number;

  switch (event.event) {
    case 'minecraft.player_command':
      title = 'Player command';
      description = `**${event.player.name}** ran a command.`;
      color = 0x5865f2;
      addEmbedField(fields, 'Command', data.command);
      break;
    case 'minecraft.server_start':
      title = 'Server started';
      description = 'STEMCraft is online.';
      color = 0x2ecc71;
      break;
    case 'minecraft.server_stop':
      title = 'Server stopping';
      description = 'STEMCraft is shutting down.';
      color = 0xe67e22;
      break;
    case 'minecraft.minigame_start':
    case 'minecraft.minigame_end': {
      const minigame = humanize(data.minigame) || 'Minigame';
      const started = event.event === 'minecraft.minigame_start';
      title = `${minigame} ${started ? 'started' : 'ended'}`;
      description = started ? `A ${minigame} match has started.` : `A ${minigame} match has ended.`;
      color = started ? 0x2ecc71 : 0x5865f2;
      const arena = isRecord(data.arena)
        ? firstText(data.arena.name, data.arena.id)
        : asText(data.arena);
      addEmbedField(fields, 'Arena', arena);
      addEmbedField(fields, 'Status', data.status);
      addEmbedField(fields, 'Players', arrayLength(data.players));
      addEmbedField(fields, 'Spectators', arrayLength(data.spectators));
      addEmbedField(fields, 'Winner', firstText(data.winner, data.winner_team));
      if (Array.isArray(data.winner_players) && data.winner_players.length > 0) {
        addEmbedField(fields, 'Winning players', data.winner_players.length);
      }
      break;
    }
    default:
      return assertNever(event);
  }

  const server = asText('server' in event ? event.server : undefined) || 'STEMCraft';
  const occurredAt = asText('occurred_at' in event ? event.occurred_at : undefined);
  const timestamp =
    occurredAt && Number.isFinite(Date.parse(occurredAt))
      ? new Date(occurredAt).toISOString()
      : undefined;

  return {
    title,
    description,
    color,
    footer: { text: `STEMCraft • ${server}` },
    ...(timestamp ? { timestamp } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };
}

function getMinecraftDeathMessage(event: MinecraftPlayerDeathEvent): string {
  return asText(event.data?.message) || `${event.player.name} died`;
}

function addEmbedField(
  fields: NonNullable<APIEmbed['fields']>,
  name: string,
  value: unknown,
): void {
  const text = asText(value);
  if (!text) return;
  fields.push({ name, value: text.slice(0, 1024), inline: true });
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return undefined;
}

function humanize(value: unknown): string | undefined {
  const text = asText(value);
  if (!text) return undefined;
  return text
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toLocaleUpperCase() + part.slice(1))
    .join(' ');
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Minecraft event: ${JSON.stringify(value)}`);
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

function normalizeHttpPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '') || '/';
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
