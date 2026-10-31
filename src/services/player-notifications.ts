import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface IgnoredMinecraftPlayer {
  uuid: string;
  username: string;
}

export interface MinecraftPlayerIdentity {
  uuid: string;
  username: string;
}

export interface PlayerNotificationService {
  addIgnoredPlayer(player: MinecraftPlayerIdentity): Promise<{
    player: IgnoredMinecraftPlayer;
    alreadyIgnored: boolean;
  }>;
  findIgnoredPlayerByUsername(username: string): Promise<IgnoredMinecraftPlayer | undefined>;
  removeIgnoredPlayer(uuid: string): Promise<IgnoredMinecraftPlayer | undefined>;
  listIgnoredPlayers(): Promise<readonly IgnoredMinecraftPlayer[]>;
  isIgnored(uuid: string | undefined): Promise<boolean>;
}

export interface PlayerNotificationServiceDependencies {
  state: StateStore<JsonState>;
  logger: AppLogger;
}

interface PlayerNotificationState {
  version: 1;
  ignoredPlayers: IgnoredMinecraftPlayer[];
}

const STATE_KEY = 'playerNotifications';

export class PersistentPlayerNotificationService implements PlayerNotificationService {
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: PlayerNotificationServiceDependencies) {}

  public addIgnoredPlayer(
    player: MinecraftPlayerIdentity,
  ): Promise<{ player: IgnoredMinecraftPlayer; alreadyIgnored: boolean }> {
    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readPlayerNotificationState(rootState[STATE_KEY]);
      const uuid = normalizeUuid(player.uuid);
      const username = normalizeUsername(player.username);
      if (!uuid || !username) {
        throw new Error('Minecraft player identity is incomplete');
      }

      const existingIndex = state.ignoredPlayers.findIndex(
        (candidate) => normalizeUuid(candidate.uuid) === uuid,
      );
      const alreadyIgnored = existingIndex >= 0;
      const ignoredPlayer = { uuid, username };
      if (existingIndex >= 0) {
        state.ignoredPlayers[existingIndex] = ignoredPlayer;
      } else {
        state.ignoredPlayers.push(ignoredPlayer);
      }

      rootState[STATE_KEY] = state;
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        { player: ignoredPlayer, alreadyIgnored },
        'Minecraft join/leave notifications ignore list updated',
      );
      return { player: ignoredPlayer, alreadyIgnored };
    });
  }

  public findIgnoredPlayerByUsername(
    username: string,
  ): Promise<IgnoredMinecraftPlayer | undefined> {
    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readPlayerNotificationState(rootState[STATE_KEY]);
      const normalizedUsername = normalizeUsername(username).toLocaleLowerCase();
      return state.ignoredPlayers.find(
        (candidate) => candidate.username.toLocaleLowerCase() === normalizedUsername,
      );
    });
  }

  public removeIgnoredPlayer(uuid: string): Promise<IgnoredMinecraftPlayer | undefined> {
    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readPlayerNotificationState(rootState[STATE_KEY]);
      const normalizedUuid = normalizeUuid(uuid);
      const index = state.ignoredPlayers.findIndex(
        (candidate) => normalizeUuid(candidate.uuid) === normalizedUuid,
      );
      if (index < 0) {
        return undefined;
      }

      const [removed] = state.ignoredPlayers.splice(index, 1);
      rootState[STATE_KEY] = state;
      await this.dependencies.state.save(rootState);
      this.dependencies.logger.info(
        { player: removed },
        'Minecraft player removed from ignore list',
      );
      return removed;
    });
  }

  public listIgnoredPlayers(): Promise<readonly IgnoredMinecraftPlayer[]> {
    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      return readPlayerNotificationState(rootState[STATE_KEY]).ignoredPlayers;
    });
  }

  public isIgnored(uuid: string | undefined): Promise<boolean> {
    return this.enqueue(async () => {
      if (!uuid?.trim()) {
        return false;
      }

      const rootState = await this.dependencies.state.load();
      const state = readPlayerNotificationState(rootState[STATE_KEY]);
      const normalizedUuid = normalizeUuid(uuid);
      return state.ignoredPlayers.some(
        (candidate) => normalizeUuid(candidate.uuid) === normalizedUuid,
      );
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export function createPlayerNotificationService(
  dependencies: PlayerNotificationServiceDependencies,
): PlayerNotificationService {
  return new PersistentPlayerNotificationService(dependencies);
}

function readPlayerNotificationState(value: unknown): PlayerNotificationState {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('version' in value) ||
    value.version !== 1 ||
    !('ignoredPlayers' in value) ||
    !Array.isArray(value.ignoredPlayers)
  ) {
    return emptyPlayerNotificationState();
  }

  const ignoredPlayers: IgnoredMinecraftPlayer[] = [];
  const seenUuids = new Set<string>();
  for (const candidate of value.ignoredPlayers) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      continue;
    }

    const uuid =
      'uuid' in candidate && typeof candidate.uuid === 'string'
        ? normalizeUuid(candidate.uuid)
        : undefined;
    const username =
      'username' in candidate && typeof candidate.username === 'string'
        ? normalizeUsername(candidate.username)
        : undefined;
    if (!uuid || !username || seenUuids.has(uuid)) {
      continue;
    }

    seenUuids.add(uuid);
    ignoredPlayers.push({ uuid, username });
  }

  return { version: 1, ignoredPlayers };
}

function emptyPlayerNotificationState(): PlayerNotificationState {
  return { version: 1, ignoredPlayers: [] };
}

function normalizeUuid(value: string): string {
  const uuid = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
    ? uuid.replaceAll('-', '')
    : uuid;
}

function normalizeUsername(value: string): string {
  return value.trim();
}
