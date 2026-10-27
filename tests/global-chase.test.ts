import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  PersistentGlobalChaseService,
  type GlobalChaseConfig,
  type GlobalChaseMessage,
  type GlobalChasePublisher,
} from '../src/services/global-chase.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: GlobalChaseConfig = {
  enabled: true,
  channelId: 'chase-channel',
  retryIntervalMs: 300000,
  maxStrikes: 3,
  idleTimeoutMs: 259200000,
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

function createMessage(id: string, content: string): GlobalChaseMessage {
  return {
    id,
    channelId: 'chase-channel',
    authorId: 'user-1',
    authorIsBot: false,
    content,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function createService(
  state: MemoryStateStore,
  publisher: GlobalChasePublisher = {
    send: vi.fn().mockResolvedValue('case-message-1'),
    edit: vi.fn().mockResolvedValue(true),
  },
): PersistentGlobalChaseService {
  return new PersistentGlobalChaseService({
    config,
    publisher,
    state,
    logger,
    random: () => 0,
    idFactory: vi.fn().mockReturnValueOnce('case-1').mockReturnValue('case-next'),
  });
}

describe('Global Chase service', () => {
  it('follows three correct locations and records the solver', async () => {
    const state = new MemoryStateStore();
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('case-message-1')
        .mockResolvedValueOnce('case-message-2')
        .mockResolvedValueOnce('case-message-3')
        .mockResolvedValueOnce('case-message-4')
        .mockResolvedValueOnce('case-message-5'),
      edit: vi.fn().mockResolvedValue(true),
    };
    const service = createService(state, publisher);

    await service.initialize();
    await service.handleMessage(createMessage('guess-1', '1'));
    await service.handleMessage(createMessage('guess-2', '2'));
    await service.handleMessage(createMessage('guess-3', '3'));

    expect(publisher.edit).not.toHaveBeenCalled();
    expect(publisher.send).toHaveBeenCalledTimes(5);
    expect(publisher.send).toHaveBeenCalledWith(
      'chase-channel',
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining('recovered') })],
      }),
    );
    await expect(service.getLeaderboard(3)).resolves.toEqual([{ userId: 'user-1', score: 1 }]);
    expect(state.state).toMatchObject({
      globalChase: { nextCaseNumber: 3, round: { caseNumber: 2 } },
    });
  });

  it('ends a case after three decoy choices', async () => {
    const state = new MemoryStateStore();
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('case-message-1')
        .mockResolvedValueOnce('case-message-2')
        .mockResolvedValueOnce('case-message-3')
        .mockResolvedValueOnce('case-message-4')
        .mockResolvedValueOnce('case-message-5'),
      edit: vi.fn().mockResolvedValue(true),
    };
    const service = createService(state, publisher);

    await service.initialize();
    await service.handleMessage(createMessage('wrong-1', '2'));
    await service.handleMessage(createMessage('wrong-2', '3'));
    await service.handleMessage(createMessage('wrong-3', '2'));

    expect(publisher.edit).not.toHaveBeenCalled();
    expect(publisher.send).toHaveBeenCalledTimes(5);
    expect(publisher.send).toHaveBeenCalledWith(
      'chase-channel',
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining('Amsterdam') })],
      }),
    );
    await expect(service.getLeaderboard(3)).resolves.toEqual([]);
  });
});
