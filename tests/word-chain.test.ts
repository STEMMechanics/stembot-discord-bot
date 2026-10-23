import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  formatStemWordChainRound,
  PersistentStemWordChainService,
  type StemWordChainConfig,
  type StemWordChainMessage,
  type StemWordChainPublisher,
  STEM_WORD_CHAIN_THEMES,
} from '../src/services/word-chain.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: StemWordChainConfig = {
  enabled: true,
  channelId: 'word-chain-channel',
  retryIntervalMs: 300000,
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

function createMessage(
  id: string,
  content: string,
  overrides: Partial<StemWordChainMessage> = {},
): StemWordChainMessage {
  return {
    id,
    channelId: 'word-chain-channel',
    authorId: `user-${id}`,
    authorIsBot: false,
    content,
    react: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService(
  state: MemoryStateStore,
  publisher: StemWordChainPublisher,
): PersistentStemWordChainService {
  return new PersistentStemWordChainService({ config, publisher, state, logger });
}

describe('STEM word chain service', () => {
  it('starts a persistent themed round and accepts words linked by their final letter', async () => {
    const state = new MemoryStateStore();
    const publisher = { send: vi.fn().mockResolvedValue('round-message-1') };
    const service = createService(state, publisher);

    await service.initialize();
    const first = createMessage('one', 'moon');
    const second = createMessage('two', 'nebula');

    await service.handleMessage(first);
    await service.handleMessage(second);

    expect(first.react).toHaveBeenCalledWith('✅');
    expect(second.react).toHaveBeenCalledWith('✅');
    expect(publisher.send).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      stemWordChain: {
        themeIndex: 0,
        roundNumber: 1,
        lastWord: 'nebula',
        streak: 2,
        bestStreak: 2,
      },
    });
  });

  it('ends the round on an invalid word, rotates the theme and keeps the best streak', async () => {
    const state = new MemoryStateStore();
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('round-message-1')
        .mockResolvedValueOnce('round-message-2'),
    };
    const service = createService(state, publisher);

    await service.initialize();
    await service.handleMessage(createMessage('one', 'moon'));
    const invalid = createMessage('two', 'robot');
    await service.handleMessage(invalid);

    expect(invalid.react).toHaveBeenCalledWith('❌');
    expect(publisher.send).toHaveBeenCalledTimes(2);
    expect(publisher.send.mock.calls[1]?.[1]).toContain('The theme is now **Biology**.');
    expect(state.state).toMatchObject({
      stemWordChain: {
        themeIndex: 1,
        roundNumber: 2,
        streak: 0,
        bestStreak: 1,
        lastWord: null,
      },
    });
  });

  it('formats the theme and chain rules in the opening message', () => {
    expect(formatStemWordChainRound(STEM_WORD_CHAIN_THEMES[0]!, 3)).toBe(
      '🔗 **Word Chain 3**\n\nTheme: **Space**\n\nStart with any word that fits the theme. Each next word must start with the last letter of the previous word.\n\nA word outside the theme or the wrong starting letter ends the round and changes the theme.',
    );
  });
});
