import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { DiscordChannelMessage } from '../src/discord/client.js';
import type { MinecraftServerStatus, StemCraftIntegration } from '../src/integrations/stemcraft.js';
import {
  PersistentServerStatusNotificationService,
  type ServerStatusNotificationConfig,
} from '../src/services/server-status-notifications.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: ServerStatusNotificationConfig = {
  enabled: true,
  channelId: 'public-server-channel',
  offlineThresholdMs: 300000,
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

function status(online: boolean): MinecraftServerStatus {
  return { online, playerCount: 0 };
}

function createService(
  state: MemoryStateStore,
  getServerStatus: () => Promise<MinecraftServerStatus>,
  sendChannelMessage: (
    channelId: string,
    message: string | DiscordChannelMessage,
  ) => Promise<string>,
  clock: () => Date,
): PersistentServerStatusNotificationService {
  const stemcraft: StemCraftIntegration = {
    getServerStatus,
    getOnlinePlayers: vi.fn(),
  };
  return new PersistentServerStatusNotificationService({
    stemcraft,
    discord: { sendChannelMessage },
    state,
    logger,
    config,
    clock,
  });
}

describe('persistent server status notifications', () => {
  it('waits for the threshold, announces offline once, then announces online', async () => {
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn().mockResolvedValue('message-id');
    const getServerStatus = vi.fn().mockResolvedValue(status(false));
    let now = new Date('2026-10-23T02:00:00.000Z');
    const service = createService(state, getServerStatus, sendChannelMessage, () => now);

    await service.synchronize();
    expect(sendChannelMessage).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      serverStatusNotifications: {
        offlineSince: '2026-10-23T02:00:00.000Z',
        offlineAlertSent: false,
      },
    });

    now = new Date('2026-10-23T02:04:59.000Z');
    await service.synchronize();
    expect(sendChannelMessage).not.toHaveBeenCalled();

    now = new Date('2026-10-23T02:05:00.000Z');
    await service.synchronize();
    await service.synchronize();
    expect(sendChannelMessage).toHaveBeenCalledOnce();
    expect(sendChannelMessage).toHaveBeenCalledWith('public-server-channel', {
      embeds: [{ color: 0xff0000, author: { name: 'Server offline' } }],
      allowedMentions: { parse: [] },
    });

    getServerStatus.mockResolvedValue(status(true));
    await service.synchronize();
    expect(sendChannelMessage).toHaveBeenCalledTimes(2);
    expect(sendChannelMessage).toHaveBeenLastCalledWith('public-server-channel', {
      embeds: [{ color: 0x00ff00, author: { name: 'Server online' } }],
      allowedMentions: { parse: [] },
    });
    expect(state.state).toMatchObject({
      serverStatusNotifications: {
        offlineSince: null,
        offlineAlertSent: false,
      },
    });
  });

  it('does not announce a short outage and is disabled without a channel', async () => {
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn().mockResolvedValue('message-id');
    let now = new Date('2026-10-23T02:00:00.000Z');
    const service = createService(
      state,
      vi.fn().mockResolvedValue(status(false)),
      sendChannelMessage,
      () => now,
    );

    await service.synchronize();
    now = new Date('2026-10-23T02:04:00.000Z');
    await service.synchronize();
    expect(sendChannelMessage).not.toHaveBeenCalled();

    const disabled = new PersistentServerStatusNotificationService({
      stemcraft: {
        getServerStatus: vi.fn().mockResolvedValue(status(false)),
        getOnlinePlayers: vi.fn(),
      },
      discord: { sendChannelMessage },
      state: new MemoryStateStore(),
      logger,
      config: { enabled: false, offlineThresholdMs: config.offlineThresholdMs },
      clock: () => now,
    });
    await disabled.synchronize();
    expect(sendChannelMessage).not.toHaveBeenCalled();
  });
});
