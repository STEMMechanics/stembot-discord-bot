import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { StemWordChainThemeValidator } from '../src/integrations/openai-word-chain.js';
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
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService(
  state: MemoryStateStore,
  publisher: StemWordChainPublisher,
  themeValidator?: StemWordChainThemeValidator,
): PersistentStemWordChainService {
  return new PersistentStemWordChainService({
    config,
    publisher,
    state,
    logger,
    ...(themeValidator ? { themeValidator } : {}),
  });
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

  it('skips a word sent before the replacement theme prompt was posted', async () => {
    const state = new MemoryStateStore();
    const publisher = {
      send: vi.fn().mockResolvedValueOnce('200').mockResolvedValueOnce('400'),
    };
    const service = createService(state, publisher);
    const invalid = createMessage('300', 'robot', { authorId: 'one' });
    const stale = createMessage('350', 'robot', { authorId: 'two' });

    await service.initialize();
    await service.handleMessage(invalid);
    await service.handleMessage(stale);

    expect(invalid.react).toHaveBeenCalledWith('❌');
    expect(stale.react).not.toHaveBeenCalled();
    expect(publisher.send).toHaveBeenCalledTimes(2);
    expect(state.state).toMatchObject({
      stemWordChain: {
        themeIndex: 1,
        roundNumber: 2,
        lastWord: null,
        streak: 0,
      },
    });
  });

  it('tracks each member’s best correct-guess streak within a round', async () => {
    const state = new MemoryStateStore();
    const publisher = { send: vi.fn().mockResolvedValue('round-message-1') };
    const service = createService(state, publisher);

    await service.initialize();
    await service.handleMessage(createMessage('one', 'moon', { authorId: 'nomad' }));
    await service.handleMessage(createMessage('two', 'nebula', { authorId: 'other' }));
    await service.handleMessage(createMessage('three', 'asteroid', { authorId: 'nomad' }));

    await expect(service.getLeaderboard(3)).resolves.toEqual([
      { userId: 'nomad', score: 2 },
      { userId: 'other', score: 1 },
    ]);
  });

  it('asks AI to validate valid themed words outside the built-in vocabulary', async () => {
    const state = new MemoryStateStore();
    const publisher = { send: vi.fn().mockResolvedValue('round-message-1') };
    const themeValidator = {
      isWordInTheme: vi.fn<StemWordChainThemeValidator['isWordInTheme']>().mockResolvedValue(true),
    };
    const service = createService(state, publisher, themeValidator);

    await service.initialize();
    const setState = (themeIndex: number, lastWord: string | null, streak: number): void => {
      state.state = {
        stemWordChain: {
          version: 1,
          themeIndex,
          roundNumber: 2,
          promptMessageId: 'round-message-2',
          lastWord,
          lastAuthorId: lastWord ? 'user-one' : null,
          lastMessageId: lastWord ? 'message-one' : null,
          streak,
          bestStreak: streak,
          roundStreaks: lastWord ? { 'user-one': streak } : {},
          bestStreaks: lastWord ? { 'user-one': streak } : {},
          processedMessageIds: [],
        },
      };
    };

    setState(1, 'animal', 1);
    const llama = createMessage('llama', 'llama');
    await service.handleMessage(llama);
    expect(llama.react).toHaveBeenCalledWith('✅');

    setState(2, 'electron', 1);
    const nitrogen = createMessage('nitrogen', 'nitrogen');
    await service.handleMessage(nitrogen);
    expect(nitrogen.react).toHaveBeenCalledWith('✅');

    setState(3, null, 0);
    const wire = createMessage('wire', 'wire');
    await service.handleMessage(wire);
    expect(wire.react).toHaveBeenCalledWith('✅');

    expect(themeValidator.isWordInTheme).toHaveBeenNthCalledWith(1, 'Biology', 'llama');
    expect(themeValidator.isWordInTheme).toHaveBeenNthCalledWith(2, 'Chemistry', 'nitrogen');
    expect(themeValidator.isWordInTheme).toHaveBeenNthCalledWith(3, 'Technology', 'wire');
  });

  it('replies with a definition without blocking the accepted move', async () => {
    const state = new MemoryStateStore();
    const publisher = { send: vi.fn().mockResolvedValue('round-message-1') };
    let resolveDefinition!: (definition: string) => void;
    const themeValidator = {
      isWordInTheme: vi.fn<StemWordChainThemeValidator['isWordInTheme']>().mockResolvedValue(true),
      getWordDefinition: vi.fn<NonNullable<StemWordChainThemeValidator['getWordDefinition']>>(
        () =>
          new Promise<string>((resolve) => {
            resolveDefinition = resolve;
          }),
      ),
    };
    const service = createService(state, publisher, themeValidator);
    await service.initialize();
    const message = createMessage('definition', 'moon');

    await service.handleMessage(message);

    expect(message.react).toHaveBeenCalledWith('✅');
    expect(message.reply).not.toHaveBeenCalled();

    resolveDefinition('a natural satellite that orbits a planet');
    await vi.waitFor(() => {
      expect(message.reply).toHaveBeenCalledWith(
        '📖 **moon** — a natural satellite that orbits a planet',
      );
    });
    expect(state.state).toMatchObject({
      stemWordChain: { lastWord: 'moon', streak: 1 },
    });
  });

  it('keeps the round open when AI theme validation is unavailable', async () => {
    const state = new MemoryStateStore();
    const publisher = { send: vi.fn().mockResolvedValue('round-message-1') };
    const themeValidator = {
      isWordInTheme: vi
        .fn<StemWordChainThemeValidator['isWordInTheme']>()
        .mockRejectedValue(new Error('OpenAI unavailable')),
    };
    const service = createService(state, publisher, themeValidator);

    await service.initialize();
    const candidate = createMessage('candidate', 'quasar');
    await service.handleMessage(candidate);

    expect(candidate.react).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      stemWordChain: {
        themeIndex: 0,
        roundNumber: 1,
        lastWord: null,
        streak: 0,
      },
    });
    expect(publisher.send).toHaveBeenCalledOnce();
  });

  it('formats the theme and chain rules in the opening message', () => {
    expect(formatStemWordChainRound(STEM_WORD_CHAIN_THEMES[0]!, 3)).toBe(
      '🔗 **Word Chain 3**\n\nTheme: **Space**\n\nStart with any word that fits the theme. Each next word must start with the last letter of the previous word.\n\nA word outside the theme or the wrong starting letter ends the round and changes the theme.',
    );
  });
});
