export interface MinecraftProfile {
  uuid: string;
  username: string;
}

export interface MinecraftProfileLookup {
  findByUsername(username: string): Promise<MinecraftProfile | undefined>;
  findByUuid?(uuid: string): Promise<MinecraftProfile | undefined>;
}

export interface MinecraftProfileLookupOptions {
  requestTimeoutMs: number;
  fetchImplementation?: typeof fetch;
}

export class MinecraftProfileLookupError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MinecraftProfileLookupError';
  }
}

export class InvalidMinecraftUsernameError extends MinecraftProfileLookupError {
  public constructor() {
    super('Minecraft usernames must contain 1 to 16 letters, numbers, or underscores');
    this.name = 'InvalidMinecraftUsernameError';
  }
}

export class InvalidMinecraftUuidError extends MinecraftProfileLookupError {
  public constructor() {
    super('Minecraft player UUIDs must contain 32 hexadecimal characters');
    this.name = 'InvalidMinecraftUuidError';
  }
}

export class MojangMinecraftProfileLookup implements MinecraftProfileLookup {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: MinecraftProfileLookupOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async findByUsername(username: string): Promise<MinecraftProfile | undefined> {
    const normalizedUsername = normalizeMinecraftUsername(username);
    if (!normalizedUsername) {
      throw new InvalidMinecraftUsernameError();
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(normalizedUsername)}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        },
      );
    } catch (error: unknown) {
      throw new MinecraftProfileLookupError('Minecraft profile lookup request failed', {
        cause: error,
      });
    }

    if (response.status === 404 || response.status === 204) {
      return undefined;
    }

    if (!response.ok) {
      throw new MinecraftProfileLookupError(
        `Minecraft profile lookup failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new MinecraftProfileLookupError('Minecraft profile lookup returned invalid JSON', {
        cause: error,
      });
    }

    const profile = parseMinecraftProfile(payload);
    if (!profile) {
      throw new MinecraftProfileLookupError('Minecraft profile lookup returned an invalid profile');
    }

    return profile;
  }

  public async findByUuid(uuid: string): Promise<MinecraftProfile | undefined> {
    const normalizedUuid = normalizeMinecraftUuid(uuid);
    if (!normalizedUuid) {
      throw new InvalidMinecraftUuidError();
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `https://sessionserver.mojang.com/session/minecraft/profile/${normalizedUuid}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        },
      );
    } catch (error: unknown) {
      throw new MinecraftProfileLookupError('Minecraft UUID lookup request failed', {
        cause: error,
      });
    }

    if (response.status === 404 || response.status === 204) {
      return undefined;
    }

    if (!response.ok) {
      throw new MinecraftProfileLookupError(
        `Minecraft UUID lookup failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new MinecraftProfileLookupError('Minecraft UUID lookup returned invalid JSON', {
        cause: error,
      });
    }

    const profile = parseMinecraftProfile(payload);
    if (!profile) {
      throw new MinecraftProfileLookupError('Minecraft UUID lookup returned an invalid profile');
    }

    return profile;
  }
}

export function createMinecraftProfileLookup(
  options: MinecraftProfileLookupOptions,
): MinecraftProfileLookup {
  return new MojangMinecraftProfileLookup(options);
}

export function normalizeMinecraftUsername(value: string): string | undefined {
  const username = value.trim();
  return /^[A-Za-z0-9_]{1,16}$/.test(username) ? username : undefined;
}

export function normalizeMinecraftUuid(value: string): string | undefined {
  const compactUuid = value.trim().replaceAll('-', '');
  return /^[0-9a-f]{32}$/i.test(compactUuid) ? compactUuid.toLowerCase() : undefined;
}

function parseMinecraftProfile(value: unknown): MinecraftProfile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const uuid = 'id' in value && typeof value.id === 'string' ? value.id.trim() : '';
  const username = 'name' in value && typeof value.name === 'string' ? value.name.trim() : '';
  const compactUuid = uuid.replaceAll('-', '');
  if (!uuid || !username || !/^[0-9a-f]{32}$/i.test(compactUuid)) {
    return undefined;
  }

  return { uuid: compactUuid.toLowerCase(), username };
}
