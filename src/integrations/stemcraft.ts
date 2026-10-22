import type { AppLogger } from '../logging/logger.js';

export interface MinecraftServerStatus {
  online: boolean;
  playerCount: number;
  maxPlayers?: number;
  version?: string;
  maintenance?: boolean;
  message?: string;
  checkedAt?: Date;
  serverAddress?: string;
  stale?: boolean;
}

/**
 * Only usernames are represented here. UUIDs and other Minecraft identity
 * fields are deliberately discarded at the integration boundary.
 */
export interface MinecraftPlayer {
  username: string;
}

export interface StemCraftIntegration {
  getServerStatus(signal?: AbortSignal): Promise<MinecraftServerStatus>;
  getOnlinePlayers(signal?: AbortSignal): Promise<readonly MinecraftPlayer[]>;
}

export class PlayerListUnavailableError extends Error {
  public constructor() {
    super('The STEMCraft status response does not provide a player list');
    this.name = 'PlayerListUnavailableError';
  }
}

export interface StemCraftHttpIntegrationOptions {
  statusUrl: string;
  requestTimeoutMs: number;
  logger: AppLogger;
  token?: string;
  fetchImplementation?: typeof fetch;
}

interface ParsedStatus extends MinecraftServerStatus {
  playerListAvailable: boolean;
  players: readonly MinecraftPlayer[];
}

type JsonObject = Record<string, unknown>;

export class StemCraftHttpIntegration implements StemCraftIntegration {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: StemCraftHttpIntegrationOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async getServerStatus(signal?: AbortSignal): Promise<MinecraftServerStatus> {
    const status = await this.fetchStatus(signal);
    return stripPlayerData(status);
  }

  public async getOnlinePlayers(signal?: AbortSignal): Promise<readonly MinecraftPlayer[]> {
    const status = await this.fetchStatus(signal);
    if (!status.playerListAvailable) {
      throw new PlayerListUnavailableError();
    }

    return status.players;
  }

  private async fetchStatus(signal?: AbortSignal): Promise<ParsedStatus> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.options.requestTimeoutMs);
    const abortListener = (): void => timeoutController.abort(signal?.reason);

    if (signal) {
      if (signal.aborted) {
        timeoutController.abort(signal.reason);
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (this.options.token) {
        headers.Authorization = `Bearer ${this.options.token}`;
      }

      const response = await this.fetchImplementation(this.options.statusUrl, {
        headers,
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        throw new Error(`STEMCraft status request failed with HTTP ${response.status}`);
      }

      const payload: unknown = await response.json();
      return parseStatus(payload);
    } catch (error: unknown) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new Error('STEMCraft status request timed out', { cause: error });
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortListener);
    }
  }
}

export function createStemCraftIntegration(
  options: StemCraftHttpIntegrationOptions,
): StemCraftIntegration {
  return new StemCraftHttpIntegration(options);
}

export class UnconfiguredStemCraftIntegration implements StemCraftIntegration {
  public async getServerStatus(): Promise<MinecraftServerStatus> {
    throw new Error('The STEMCraft integration has not been configured');
  }

  public async getOnlinePlayers(): Promise<readonly MinecraftPlayer[]> {
    throw new Error('The STEMCraft integration has not been configured');
  }
}

function parseStatus(value: unknown): ParsedStatus {
  const payload = asObject(value);
  if (!payload) {
    throw new Error('STEMCraft status response was not a JSON object');
  }

  const statusValue = readString(payload.status)?.toLowerCase();
  const online = readBoolean(payload.online) ?? statusValue === 'online';
  const maintenance = readBoolean(payload.maintenance) ?? statusValue === 'maintenance';
  const rawPlayers = firstProperty(payload, [
    'players',
    'online_players',
    'onlinePlayers',
    'player_list',
    'playerList',
  ]);
  const playerListAvailable = rawPlayers !== undefined;
  const maxPlayers = readNonNegativeInteger(firstProperty(payload, ['max_players', 'maxPlayers']));
  const version = readString(payload.version);
  const message = readString(payload.message);
  const checkedAt = parseDate(payload.checked_at ?? payload.checkedAt);
  const serverAddress = readString(payload.server_address ?? payload.serverAddress);
  const stale = readBoolean(payload.stale);

  return {
    online,
    playerCount:
      readNonNegativeInteger(
        firstProperty(payload, ['players_online', 'playersOnline', 'playerCount']),
      ) ?? (Array.isArray(rawPlayers) ? rawPlayers.length : 0),
    ...(maxPlayers !== undefined ? { maxPlayers } : {}),
    ...(version ? { version } : {}),
    ...(maintenance !== undefined ? { maintenance } : {}),
    ...(message ? { message } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    ...(serverAddress ? { serverAddress } : {}),
    ...(stale !== undefined ? { stale } : {}),
    playerListAvailable,
    players: parsePlayers(rawPlayers),
  };
}

function parsePlayers(value: unknown): readonly MinecraftPlayer[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const players: MinecraftPlayer[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    const username = typeof candidate === 'string' ? candidate.trim() : readPlayerName(candidate);
    if (!username || seen.has(username.toLowerCase())) {
      continue;
    }

    seen.add(username.toLowerCase());
    players.push({ username });
  }

  return players;
}

function readPlayerName(value: unknown): string | undefined {
  const object = asObject(value);
  if (!object) {
    return undefined;
  }

  for (const field of ['username', 'name', 'player_name', 'displayName']) {
    const name = readString(object[field]);
    if (name) {
      return name;
    }
  }

  return undefined;
}

function stripPlayerData(status: ParsedStatus): MinecraftServerStatus {
  return {
    online: status.online,
    playerCount: status.playerCount,
    ...(status.maxPlayers !== undefined ? { maxPlayers: status.maxPlayers } : {}),
    ...(status.version ? { version: status.version } : {}),
    ...(status.maintenance !== undefined ? { maintenance: status.maintenance } : {}),
    ...(status.message ? { message: status.message } : {}),
    ...(status.checkedAt ? { checkedAt: status.checkedAt } : {}),
    ...(status.serverAddress ? { serverAddress: status.serverAddress } : {}),
    ...(status.stale !== undefined ? { stale: status.stale } : {}),
  };
}

function firstProperty(object: JsonObject, fields: readonly string[]): unknown {
  for (const field of fields) {
    if (field in object) {
      return object[field];
    }
  }

  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const result = String(value).trim();
  return result || undefined;
}

function parseDate(value: unknown): Date | undefined {
  const stringValue = readString(value);
  if (!stringValue) {
    return undefined;
  }

  const parsed = new Date(stringValue);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
