import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { DiscordChannelMessage } from '../src/discord/client.js';
import type { UptimeKumaStatus } from '../src/integrations/uptime-kuma.js';
import {
  PersistentUptimeStatusService,
  type UptimeStatusConfig,
} from '../src/services/uptime-status.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: UptimeStatusConfig = {
  statusPageUrl: 'https://uptime.example.test/status/stem',
  statusChannelId: 'status-channel',
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

function status(overrides: Partial<UptimeKumaStatus> = {}): UptimeKumaStatus {
  return {
    overall: 'up',
    title: 'STEMMechanics Status',
    statusPageUrl: config.statusPageUrl,
    checkedAt: new Date('2026-10-23T00:00:00.000Z'),
    monitors: [{ id: '1', name: 'Website', state: 'up' }],
    ...overrides,
  };
}

function createService(
  state: MemoryStateStore,
  getStatus: () => Promise<UptimeKumaStatus>,
  sendChannelMessage: (
    channelId: string,
    message: string | DiscordChannelMessage,
  ) => Promise<string>,
  editChannelMessage: (
    channelId: string,
    messageId: string,
    message: string | DiscordChannelMessage,
  ) => Promise<boolean>,
): PersistentUptimeStatusService {
  return new PersistentUptimeStatusService({
    uptime: { getStatus },
    discord: { sendChannelMessage, editChannelMessage },
    state,
    logger,
    config,
  });
}

describe('persistent uptime status', () => {
  it('creates once, persists the message ID, and edits it on later synchronizations', async () => {
    const state = new MemoryStateStore();
    const getStatus = vi.fn().mockResolvedValue(status());
    const sendChannelMessage = vi.fn().mockResolvedValue('status-message-1');
    const editChannelMessage = vi.fn().mockResolvedValue(true);
    const service = createService(state, getStatus, sendChannelMessage, editChannelMessage);

    await service.synchronize();
    await service.synchronize();

    expect(sendChannelMessage).toHaveBeenCalledOnce();
    expect(editChannelMessage).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      uptimeStatus: { version: 1, messageId: 'status-message-1' },
    });
  });

  it('creates a replacement when the stored Discord message no longer exists', async () => {
    const state = new MemoryStateStore();
    state.state = { uptimeStatus: { version: 1, messageId: 'deleted-message' } };
    const sendChannelMessage = vi.fn().mockResolvedValue('status-message-2');
    const editChannelMessage = vi.fn().mockResolvedValue(false);
    const service = createService(
      state,
      vi.fn().mockResolvedValue(status({ overall: 'down' })),
      sendChannelMessage,
      editChannelMessage,
    );

    await service.synchronize();

    expect(sendChannelMessage).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      uptimeStatus: { version: 1, messageId: 'status-message-2' },
    });
  });

  it('publishes a red card when Kuma cannot be read', async () => {
    const state = new MemoryStateStore();
    const sendChannelMessage = vi.fn().mockResolvedValue('status-message-1');
    const service = createService(
      state,
      vi.fn().mockRejectedValue(new Error('connection refused')),
      sendChannelMessage,
      vi.fn().mockResolvedValue(true),
    );

    await service.synchronize();

    expect(sendChannelMessage.mock.calls[0]?.[1]).toMatchObject({
      embeds: [
        expect.objectContaining({
          color: 0xe74c3c,
          description: expect.stringContaining('Monitoring unavailable'),
        }),
      ],
    });
  });
});
