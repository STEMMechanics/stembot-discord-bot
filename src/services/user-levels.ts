import type { APIEmbed } from 'discord.js';

import type { AppLogger } from '../logging/logger.js';
import type { JsonState, StateStore } from '../state/state-store.js';

export interface UserLevelConfig {
  enabled: boolean;
  messageXp: number;
  reactionXp: number;
  gameXp: number;
  messageCooldownMs: number;
  reactionCooldownMs: number;
  announcementChannelId?: string;
}

export interface UserLevelProfile {
  userId: string;
  xp: number;
  level: number;
  messageCount: number;
  reactionCount: number;
  gameCount: number;
  lastMessageXpAt: string | null;
  lastReactionXpAt: string | null;
}

export interface UserLevelAward {
  profile: UserLevelProfile;
  xpGained: number;
  levelUp: boolean;
}

export interface UserLevelAnnouncement {
  channelId: string;
  content: string;
  embeds?: APIEmbed[];
  allowedUserIds?: readonly string[];
}

export interface UserLevelAnnouncementPublisher {
  send(announcement: UserLevelAnnouncement): Promise<void>;
}

export interface UserLevelService {
  recordMessage(userId: string): Promise<UserLevelAward | undefined>;
  recordReaction(userId: string): Promise<UserLevelAward | undefined>;
  recordGameParticipation(userId: string): Promise<UserLevelAward | undefined>;
  getProfile(userId: string): Promise<UserLevelProfile>;
  getLeaderboard(limit: number): Promise<readonly UserLevelProfile[]>;
}

interface StoredUserLevelProfile {
  xp: number;
  level: number;
  lastAnnouncedLevel: number;
  messageCount: number;
  reactionCount: number;
  gameCount: number;
  lastMessageXpAt: string | null;
  lastReactionXpAt: string | null;
}

interface UserLevelState {
  version: 1;
  users: Record<string, StoredUserLevelProfile>;
}

type AwardKind = 'message' | 'reaction' | 'game';

const STATE_KEY = 'userLevels';
const XP_PER_LEVEL = 100;

export class PersistentUserLevelService implements UserLevelService {
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dependencies: {
      config: UserLevelConfig;
      state: StateStore<JsonState>;
      logger: AppLogger;
      announcementPublisher?: UserLevelAnnouncementPublisher;
      clock?: () => Date;
    },
  ) {}

  public async recordMessage(userId: string): Promise<UserLevelAward | undefined> {
    return this.award(
      userId,
      'message',
      this.dependencies.config.messageXp,
      this.dependencies.config.messageCooldownMs,
    );
  }

  public async recordReaction(userId: string): Promise<UserLevelAward | undefined> {
    return this.award(
      userId,
      'reaction',
      this.dependencies.config.reactionXp,
      this.dependencies.config.reactionCooldownMs,
    );
  }

  public async recordGameParticipation(userId: string): Promise<UserLevelAward | undefined> {
    return this.award(userId, 'game', this.dependencies.config.gameXp, 0);
  }

  public async getProfile(userId: string): Promise<UserLevelProfile> {
    if (!this.dependencies.config.enabled || userId.trim().length === 0) {
      return createProfile(userId);
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readUserLevelState(rootState[STATE_KEY]);
      return toProfile(userId, state.users[userId] ?? createStoredProfile());
    });
  }

  public async getLeaderboard(limit: number): Promise<readonly UserLevelProfile[]> {
    if (!this.dependencies.config.enabled) {
      return [];
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readUserLevelState(rootState[STATE_KEY]);
      return Object.entries(state.users)
        .map(([userId, profile]) => toProfile(userId, profile))
        .sort(
          (left, right) =>
            right.xp - left.xp ||
            right.level - left.level ||
            left.userId.localeCompare(right.userId),
        )
        .slice(0, Math.max(1, Math.min(25, Math.floor(limit))));
    });
  }

  private async award(
    userId: string,
    kind: AwardKind,
    xpGained: number,
    cooldownMs: number,
  ): Promise<UserLevelAward | undefined> {
    if (!this.dependencies.config.enabled || userId.trim().length === 0) {
      return undefined;
    }

    return this.enqueue(async () => {
      const rootState = await this.dependencies.state.load();
      const state = readUserLevelState(rootState[STATE_KEY]);
      const storedProfile = state.users[userId] ?? createStoredProfile();
      const now = this.currentTime();
      const lastAwardAt =
        kind === 'message'
          ? storedProfile.lastMessageXpAt
          : kind === 'reaction'
            ? storedProfile.lastReactionXpAt
            : null;

      if (lastAwardAt && now.getTime() - Date.parse(lastAwardAt) < cooldownMs) {
        return undefined;
      }

      const previousLevel = storedProfile.level;
      storedProfile.xp += xpGained;
      storedProfile.level = getLevelForXp(storedProfile.xp);
      if (kind === 'message') {
        storedProfile.messageCount += 1;
        storedProfile.lastMessageXpAt = now.toISOString();
      } else if (kind === 'reaction') {
        storedProfile.reactionCount += 1;
        storedProfile.lastReactionXpAt = now.toISOString();
      } else {
        storedProfile.gameCount += 1;
      }

      const levelUp = storedProfile.level > previousLevel;
      const shouldAnnounceLevelUp =
        Boolean(this.dependencies.config.announcementChannelId) &&
        Boolean(this.dependencies.announcementPublisher) &&
        storedProfile.level > storedProfile.lastAnnouncedLevel;
      if (shouldAnnounceLevelUp) {
        storedProfile.lastAnnouncedLevel = storedProfile.level;
      }

      state.users[userId] = storedProfile;
      rootState[STATE_KEY] = state;
      await this.dependencies.state.save(rootState);

      const profile = toProfile(userId, storedProfile);
      const award = {
        profile,
        xpGained,
        levelUp,
      };
      this.dependencies.logger.info(
        {
          userId,
          awardKind: kind,
          xpGained,
          totalXp: profile.xp,
          level: profile.level,
          levelUp: award.levelUp,
          announcementScheduled: shouldAnnounceLevelUp,
        },
        'User activity XP awarded',
      );
      if (shouldAnnounceLevelUp) {
        await this.announceLevelUp(award.profile);
      }
      return award;
    });
  }

  private async announceLevelUp(profile: UserLevelProfile): Promise<void> {
    const channelId = this.dependencies.config.announcementChannelId;
    const publisher = this.dependencies.announcementPublisher;
    if (!channelId || !publisher) {
      return;
    }

    try {
      await publisher.send({
        channelId,
        content: `<@${profile.userId}>`,
        embeds: [buildLevelUpEmbed(profile)],
        allowedUserIds: [profile.userId],
      });
    } catch (error: unknown) {
      this.dependencies.logger.warn(
        { err: error, channelId, userId: profile.userId, level: profile.level },
        'User level-up announcement could not be sent',
      );
    }
  }

  private currentTime(): Date {
    return this.dependencies.clock?.() ?? new Date();
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

function buildLevelUpEmbed(profile: UserLevelProfile): APIEmbed {
  const previousLevelXp = profile.level <= 1 ? 0 : getXpForNextLevel(profile.level - 1);
  const nextLevelXp = getXpForNextLevel(profile.level);
  const requiredXp = Math.max(1, nextLevelXp - previousLevelXp);
  const currentXp = Math.max(0, profile.xp - previousLevelXp);
  const percent = Math.min(100, Math.floor((currentXp / requiredXp) * 100));

  return {
    title: '🎉 Level up!',
    color: 0x5865f2,
    description: [
      `<@${profile.userId}> reached **level ${profile.level}**!`,
      `${formatLevelProgressBar(percent)} **${profile.xp} XP**`,
    ].join('\n'),
    fields: [
      { name: 'New level', value: `**${profile.level}**`, inline: true },
      { name: 'Progress', value: `${percent}% complete`, inline: true },
      {
        name: 'Next level',
        value: `${Math.max(0, nextLevelXp - profile.xp)} XP to level ${profile.level + 1}`,
        inline: true,
      },
    ],
    footer: { text: 'STEMBot levels' },
  };
}

function formatLevelProgressBar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 10);
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
}

export function createUserLevelService(dependencies: {
  config: UserLevelConfig;
  state: StateStore<JsonState>;
  logger: AppLogger;
  announcementPublisher?: UserLevelAnnouncementPublisher;
  clock?: () => Date;
}): UserLevelService {
  return new PersistentUserLevelService(dependencies);
}

export function getLevelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / XP_PER_LEVEL)) + 1;
}

export function getXpForNextLevel(level: number): number {
  return Math.max(1, Math.floor(level)) ** 2 * XP_PER_LEVEL;
}

function readUserLevelState(value: unknown): UserLevelState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.users)) {
    return createInitialState();
  }

  const users: Record<string, StoredUserLevelProfile> = {};
  for (const [userId, valueForUser] of Object.entries(value.users)) {
    const profile = readStoredProfile(valueForUser);
    if (profile) {
      users[userId] = profile;
    }
  }

  return { version: 1, users };
}

function readStoredProfile(value: unknown): StoredUserLevelProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const xp = readNonNegativeInteger(value.xp);
  const messageCount = readNonNegativeInteger(value.messageCount);
  const reactionCount = readNonNegativeInteger(value.reactionCount);
  const gameCount = readNonNegativeInteger(value.gameCount);
  if (
    xp === undefined ||
    messageCount === undefined ||
    reactionCount === undefined ||
    gameCount === undefined
  ) {
    return undefined;
  }

  const level = getLevelForXp(xp);
  const storedLastAnnouncedLevel = readNonNegativeInteger(value.lastAnnouncedLevel);
  return {
    xp,
    level,
    lastAnnouncedLevel:
      storedLastAnnouncedLevel === undefined ? level : Math.max(1, storedLastAnnouncedLevel),
    messageCount,
    reactionCount,
    gameCount,
    lastMessageXpAt: readNullableString(value.lastMessageXpAt),
    lastReactionXpAt: readNullableString(value.lastReactionXpAt),
  };
}

function createInitialState(): UserLevelState {
  return { version: 1, users: {} };
}

function createStoredProfile(): StoredUserLevelProfile {
  return {
    xp: 0,
    level: 1,
    lastAnnouncedLevel: 1,
    messageCount: 0,
    reactionCount: 0,
    gameCount: 0,
    lastMessageXpAt: null,
    lastReactionXpAt: null,
  };
}

function createProfile(userId: string): UserLevelProfile {
  return toProfile(userId, createStoredProfile());
}

function toProfile(userId: string, profile: StoredUserLevelProfile): UserLevelProfile {
  return {
    userId,
    xp: profile.xp,
    level: profile.level,
    messageCount: profile.messageCount,
    reactionCount: profile.reactionCount,
    gameCount: profile.gameCount,
    lastMessageXpAt: profile.lastMessageXpAt,
    lastReactionXpAt: profile.lastReactionXpAt,
  };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
