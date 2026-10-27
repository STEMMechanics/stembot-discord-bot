import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { ButtonGameBoard, ButtonGameInteraction } from '../src/services/button-games.js';
import {
  PersistentConnectFourService,
  type ConnectFourConfig,
  type ConnectFourPublisher,
} from '../src/services/connect-four.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: ConnectFourConfig = {
  enabled: true,
  channelId: 'game-channel',
  retryIntervalMs: 300000,
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

function createInteraction(
  userId: string,
  customId: string,
  messageId = 'board-0',
): ButtonGameInteraction {
  return {
    channelId: 'game-channel',
    messageId,
    userId,
    customId,
    update: vi.fn<(board: ButtonGameBoard) => Promise<void>>().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function createService(
  state: MemoryStateStore,
  publisher: ConnectFourPublisher = {
    send: vi.fn().mockResolvedValue('board-0'),
    edit: vi.fn().mockResolvedValue(true),
  },
): PersistentConnectFourService {
  return new PersistentConnectFourService({
    config,
    publisher,
    state,
    logger,
    idFactory: vi.fn().mockReturnValueOnce('game-1').mockReturnValue('game-next'),
    random: () => 0,
  });
}

describe('Connect 4 service', () => {
  it('posts a persistent board and responds with a bot move', async () => {
    const state = new MemoryStateStore();
    const publisher = {
      send: vi.fn().mockResolvedValue('board-0'),
      edit: vi.fn().mockResolvedValue(true),
    };
    const service = createService(state, publisher);

    await service.initialize();
    const move = createInteraction('user-1', 'connect4:game-1:0');
    await service.handleButton(move);

    expect(publisher.send).toHaveBeenCalledWith(
      'game-channel',
      expect.objectContaining({ content: expect.stringContaining('claim this round') }),
    );
    expect(move.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('STEMBot played column **4**.') }),
    );
    expect(state.state).toMatchObject({
      connectFour: { game: { boardMessageId: 'board-0', playerId: 'user-1' } },
    });
  });

  it('rejects stale boards and clicks from another player', async () => {
    const state = new MemoryStateStore();
    const service = createService(state);
    await service.initialize();

    const stale = createInteraction('user-1', 'connect4:game-1:0', 'old-board');
    await service.handleButton(stale);
    const firstMove = createInteraction('user-1', 'connect4:game-1:0');
    await service.handleButton(firstMove);
    const otherPlayer = createInteraction('user-2', 'connect4:game-1:1');
    await service.handleButton(otherPlayer);

    expect(stale.reply).toHaveBeenCalledWith('That Connect 4 board is no longer active.');
    expect(otherPlayer.reply).toHaveBeenCalledWith(
      'This round is being played by <@user-1>. Wait for the next round.',
    );
  });
});
