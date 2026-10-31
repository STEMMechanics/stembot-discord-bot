import type { MinecraftProfile } from './minecraft-profile.js';

export interface MinecraftPlayerStat {
  key: string;
  title: string;
  value: number;
  description?: string;
}

export interface MinecraftPlayerStats {
  available: boolean;
  period: string;
  updatedAt?: string;
  items: readonly MinecraftPlayerStat[];
}

export interface MinecraftPlayerProfileSnapshot {
  profile: MinecraftProfile;
  platform?: string;
  online: boolean;
  generatedAt?: string;
  stats?: MinecraftPlayerStats;
}

export interface MinecraftPlayerProfileLookupOptions {
  include?: readonly string[];
  period?: string;
}

export interface MinecraftPlayerProfileLookup {
  findByUuid(
    uuid: string,
    options?: MinecraftPlayerProfileLookupOptions,
  ): Promise<MinecraftPlayerProfileSnapshot | undefined>;
}

export interface MinecraftPlayerProfileHttpLookupOptions {
  apiUrl: string;
  token: string;
  requestTimeoutMs: number;
  fetchImplementation?: typeof fetch;
}

export class MinecraftPlayerProfileLookupError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MinecraftPlayerProfileLookupError';
  }
}

export class MinecraftPlayerProfileHttpLookup implements MinecraftPlayerProfileLookup {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: MinecraftPlayerProfileHttpLookupOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async findByUuid(
    uuid: string,
    lookupOptions: MinecraftPlayerProfileLookupOptions = {},
  ): Promise<MinecraftPlayerProfileSnapshot | undefined> {
    const normalizedUuid = normalizeMinecraftUuid(uuid);
    if (!normalizedUuid) {
      throw new MinecraftPlayerProfileLookupError('Minecraft player UUID is invalid');
    }

    const endpoint = new URL(
      `${this.options.apiUrl.replace(/\/+$/, '')}/players/${formatMinecraftUuidForApi(normalizedUuid)}/profile`,
    );
    const include = lookupOptions.include?.filter((section) => section.trim().length > 0);
    if (include && include.length > 0) {
      endpoint.searchParams.set('include', include.join(','));
    }
    if (lookupOptions.period?.trim()) {
      endpoint.searchParams.set('period', lookupOptions.period.trim());
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(endpoint, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.options.token}`,
        },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error: unknown) {
      throw new MinecraftPlayerProfileLookupError('STEMCraft player profile request failed', {
        cause: error,
      });
    }

    if (response.status === 404 || response.status === 204) {
      return undefined;
    }

    if (!response.ok) {
      throw new MinecraftPlayerProfileLookupError(
        `STEMCraft player profile request failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new MinecraftPlayerProfileLookupError(
        'STEMCraft player profile returned invalid JSON',
        { cause: error },
      );
    }

    const profile = parseMinecraftPlayerProfileSnapshot(payload);
    if (!profile) {
      throw new MinecraftPlayerProfileLookupError(
        'STEMCraft player profile returned an invalid profile',
      );
    }

    return profile;
  }
}

export function createMinecraftPlayerProfileLookup(
  options: MinecraftPlayerProfileHttpLookupOptions,
): MinecraftPlayerProfileLookup {
  return new MinecraftPlayerProfileHttpLookup(options);
}

export function normalizeMinecraftUuid(value: string): string | undefined {
  const compactUuid = value.trim().replaceAll('-', '');
  return /^[0-9a-f]{32}$/i.test(compactUuid) ? compactUuid.toLowerCase() : undefined;
}

function formatMinecraftUuidForApi(compactUuid: string): string {
  return [
    compactUuid.slice(0, 8),
    compactUuid.slice(8, 12),
    compactUuid.slice(12, 16),
    compactUuid.slice(16, 20),
    compactUuid.slice(20),
  ].join('-');
}

function parseMinecraftPlayerProfileSnapshot(
  value: unknown,
): MinecraftPlayerProfileSnapshot | undefined {
  const payload = asObject(value);
  const player = payload ? asObject(payload.player) : undefined;
  if (!payload || !player) {
    return undefined;
  }

  const uuid = readString(player.uuid);
  const username = readString(player.name);
  const normalizedUuid = uuid ? normalizeMinecraftUuid(uuid) : undefined;
  if (!normalizedUuid || !username) {
    return undefined;
  }

  const stats = parseStatsSection(payload.sections);
  const platform = readString(player.platform);
  const generatedAt = readString(payload.generated_at);

  return {
    profile: { uuid: normalizedUuid, username },
    ...(platform ? { platform } : {}),
    online: player.online === true,
    ...(generatedAt ? { generatedAt } : {}),
    ...(stats ? { stats } : {}),
  };
}

function parseStatsSection(value: unknown): MinecraftPlayerStats | undefined {
  const sections = asObject(value);
  const section = sections ? asObject(sections.stats) : undefined;
  if (!section) {
    return undefined;
  }

  const period = readString(section.period) ?? 'all';
  const items = Array.isArray(section.items)
    ? section.items.flatMap((item) => {
        const parsed = parseStat(item);
        return parsed ? [parsed] : [];
      })
    : [];
  const updatedAt = readString(section.updated_at);

  return {
    available: section.available === true,
    period,
    ...(updatedAt ? { updatedAt } : {}),
    items,
  };
}

function parseStat(value: unknown): MinecraftPlayerStat | undefined {
  const stat = asObject(value);
  if (!stat) {
    return undefined;
  }

  const key = readString(stat.key);
  const title = readString(stat.title);
  const statValue = typeof stat.value === 'number' ? stat.value : undefined;
  if (!key || !title || statValue === undefined || !Number.isFinite(statValue)) {
    return undefined;
  }

  const description = readString(stat.description);
  return {
    key,
    title,
    value: statValue,
    ...(description ? { description } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
