import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  getLevelForXp,
  getXpForNextLevel,
  PersistentUserLevelService,
  type UserLevelConfig,
} from '../src/services/user-levels.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: UserLevelConfig = {
  enabled: true,
  messageXp: 5,
  reactionXp: 2,
  gameXp: 15,
  messageCooldownMs: 60_000,
  reactionCooldownMs: 30_000,
};

class MemoryStateStore implements StateStore<JsonState> {
  public state: JsonState = {};

  public async load(): Promise<JsonState> {
    return this.state;
  }

  public async save(state: JsonState): Promise<void> {
    this.state = state;
  }
}

function createService(state: MemoryStateStore, now = new Date('2026-10-23T02:00:00.000Z')) {
  return new PersistentUserLevelService({
    config,
    state,
    logger,
    clock: () => now,
  });
}

describe('persistent user levels', () => {
  it('awards message XP once per cooldown and records reactions and game participation', async () => {
    const state = new MemoryStateStore();
    const service = createService(state);

    await expect(service.recordMessage('user-1')).resolves.toMatchObject({
      xpGained: 5,
      profile: { xp: 5, level: 1, messageCount: 1 },
      levelUp: false,
    });
    await expect(service.recordMessage('user-1')).resolves.toBeUndefined();
    await expect(service.recordReaction('user-1')).resolves.toMatchObject({
      xpGained: 2,
      profile: { xp: 7, reactionCount: 1 },
    });
    await expect(service.recordGameParticipation('user-1')).resolves.toMatchObject({
      xpGained: 15,
      profile: { xp: 22, gameCount: 1 },
    });
  });

  it('calculates escalating levels and persists profiles across service instances', async () => {
    const state = new MemoryStateStore();
    const service = createService(state);

    for (let index = 0; index < 20; index += 1) {
      await service.recordGameParticipation('user-1');
    }

    const profile = await createService(state).getProfile('user-1');
    expect(profile).toMatchObject({ xp: 300, level: 2, gameCount: 20 });
    expect(getLevelForXp(0)).toBe(1);
    expect(getLevelForXp(100)).toBe(2);
    expect(getXpForNextLevel(2)).toBe(400);
  });

  it('announces a level-up in the configured channel without losing the XP award on failure', async () => {
    const state = new MemoryStateStore();
    const send = vi.fn().mockRejectedValue(new Error('Discord unavailable'));
    const service = new PersistentUserLevelService({
      config: { ...config, announcementChannelId: 'announcement-channel' },
      state,
      logger,
      announcementPublisher: { send },
    });

    for (let index = 0; index < 7; index += 1) {
      await service.recordGameParticipation('user-1');
    }

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      channelId: 'announcement-channel',
      content: '<@user-1>',
      embeds: [
        expect.objectContaining({
          title: '🎉 Level up!',
          description: expect.stringContaining('<@user-1> reached **level 2**!'),
          fields: expect.arrayContaining([
            expect.objectContaining({ name: 'New level', value: '**2**' }),
          ]),
        }),
      ],
      allowedUserIds: ['user-1'],
    });
    await expect(service.getProfile('user-1')).resolves.toMatchObject({ xp: 105, level: 2 });
  });

  it('does not repeat a level-up announcement when a stale award sees an already announced level', async () => {
    const state = new MemoryStateStore();
    state.state = {
      userLevels: {
        version: 1,
        users: {
          'user-1': {
            xp: 397,
            level: 2,
            lastAnnouncedLevel: 3,
            messageCount: 0,
            reactionCount: 0,
            gameCount: 0,
            lastMessageXpAt: null,
            lastReactionXpAt: null,
          },
        },
      },
    };
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new PersistentUserLevelService({
      config: { ...config, announcementChannelId: 'announcement-channel' },
      state,
      logger,
      announcementPublisher: { send },
    });

    await service.recordGameParticipation('user-1');

    expect(send).not.toHaveBeenCalled();
    await expect(service.getProfile('user-1')).resolves.toMatchObject({ xp: 412, level: 3 });
  });

  it('sorts the leaderboard by XP and limits the result', async () => {
    const state = new MemoryStateStore();
    const service = createService(state);

    for (let index = 0; index < 3; index += 1) {
      await service.recordGameParticipation('user-1');
    }
    for (let index = 0; index < 2; index += 1) {
      await service.recordGameParticipation('user-2');
    }

    const leaderboard = await service.getLeaderboard(1);
    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0]).toMatchObject({ userId: 'user-1', xp: 45 });
  });
});
