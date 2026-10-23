import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { StemWordChainThemeValidator } from '../src/integrations/openai-word-chain.js';
import {
  formatStemWordChainRound,
  extractWordChainCandidate,
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
    clock: () => new Date('2026-10-23T02:00:00.000Z'),
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
    expect(publisher.send.mock.calls[1]?.[1]).toContain('Streak this game: **1**');
    expect(publisher.send.mock.calls[1]?.[1]).toContain('Current highest game streak: **1**');
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

  it('ends the round when a word is repeated in the same game', async () => {
    const state = new MemoryStateStore();
    state.state = {
      stemWordChain: {
        version: 1,
        themeIndex: 0,
        roundNumber: 4,
        promptMessageId: '100',
        lastWord: 'fusion',
        lastAuthorId: 'user-one',
        lastMessageId: '150',
        streak: 3,
        bestStreak: 3,
        roundStreaks: { 'user-one': 3 },
        bestStreaks: { 'user-one': 3 },
        usedWords: ['moon', 'nebula', 'fusion'],
        processedMessageIds: [],
      },
    };
    const publisher = { send: vi.fn().mockResolvedValue('round-message-5') };
    const service = createService(state, publisher);
    const repeated = createMessage('200', 'nebula');

    await service.handleMessage(repeated);

    expect(repeated.react).toHaveBeenCalledWith('❌');
    expect(publisher.send).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      stemWordChain: {
        themeIndex: 1,
        roundNumber: 5,
        usedWords: [],
        hintHistory: [],
      },
    });
  });

  it('keeps the round open for a one-letter typo in a themed word', async () => {
    const state = new MemoryStateStore();
    state.state = {
      stemWordChain: {
        version: 1,
        themeIndex: 3,
        roundNumber: 4,
        promptMessageId: '100',
        lastWord: 'robot',
        lastAuthorId: 'user-one',
        lastMessageId: '150',
        streak: 1,
        bestStreak: 1,
        roundStreaks: { 'user-one': 1 },
        bestStreaks: { 'user-one': 1 },
        usedWords: ['robot'],
        processedMessageIds: [],
      },
    };
    const publisher = { send: vi.fn().mockResolvedValue('round-message-4') };
    const service = createService(state, publisher);
    const typo = createMessage('200', 'Typescrip');

    await service.handleMessage(typo);

    expect(typo.react).toHaveBeenCalledWith('🤔');
    expect(typo.react).not.toHaveBeenCalledWith('❌');
    expect(typo.reply).toHaveBeenCalledWith(
      '🤔 Close! Check the spelling and try again — the round is still open.',
    );
    expect(publisher.send).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      stemWordChain: {
        themeIndex: 3,
        roundNumber: 4,
        lastWord: 'robot',
        streak: 1,
      },
    });
  });

  it('accepts a word followed by a parenthetical explanation', async () => {
    const state = new MemoryStateStore();
    state.state = {
      stemWordChain: {
        version: 1,
        themeIndex: 4,
        roundNumber: 2,
        promptMessageId: '100',
        lastWord: 'planet',
        lastAuthorId: 'user-one',
        lastMessageId: '150',
        streak: 1,
        bestStreak: 1,
        roundStreaks: { 'user-one': 1 },
        bestStreaks: { 'user-one': 1 },
        usedWords: ['planet'],
        processedMessageIds: [],
      },
    };
    const publisher = { send: vi.fn().mockResolvedValue('round-message-2') };
    const service = createService(state, publisher);
    const transfer = createMessage('200', 'transfer (with energy)');

    await service.handleMessage(transfer);

    expect(extractWordChainCandidate('transfer (with energy)')).toBe('transfer');
    expect(transfer.react).toHaveBeenCalledWith('✅');
    expect(state.state).toMatchObject({
      stemWordChain: {
        themeIndex: 4,
        lastWord: 'transfer',
        streak: 2,
      },
    });
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
        '📖 moon — a natural satellite that orbits a planet\n\nGive me a word starting with **N** on the theme of **Space**. No previous **N** words have been used yet.',
      );
    });
    expect(state.state).toMatchObject({
      stemWordChain: { lastWord: 'moon', streak: 1 },
    });
  });

  it('includes an earlier word when it matches the next starting letter', async () => {
    const state = new MemoryStateStore();
    state.state = {
      stemWordChain: {
        version: 1,
        themeIndex: 2,
        roundNumber: 18,
        promptMessageId: '100',
        lastWord: 'chemical',
        lastAuthorId: 'user-one',
        lastMessageId: '150',
        streak: 1,
        bestStreak: 1,
        roundStreaks: { 'user-one': 1 },
        bestStreaks: { 'user-one': 1 },
        usedWords: ['chemical'],
        processedMessageIds: [],
      },
    };
    const publisher = { send: vi.fn().mockResolvedValue('round-message-18') };
    const themeValidator = {
      isWordInTheme: vi.fn<StemWordChainThemeValidator['isWordInTheme']>().mockResolvedValue(true),
      getWordDefinition: vi
        .fn<NonNullable<StemWordChainThemeValidator['getWordDefinition']>>()
        .mockResolvedValue('A word used in chemistry.'),
    };
    const service = createService(state, publisher, themeValidator);
    const message = createMessage('200', 'lactic');

    await service.handleMessage(message);

    await vi.waitFor(() => {
      expect(message.reply).toHaveBeenCalledWith(
        "📖 lactic — A word used in chemistry.\n\nGive me a word starting with **C** on the theme of **Chemistry**. You can't use the word **chemical**.",
      );
    });
  });

  it('provides a theme-aware hint without using an accepted or previously hinted word', async () => {
    const state = new MemoryStateStore();
    state.state = {
      stemWordChain: {
        version: 1,
        themeIndex: 0,
        roundNumber: 1,
        promptMessageId: '100',
        lastWord: 'fusion',
        lastAuthorId: 'user-one',
        lastMessageId: '150',
        streak: 1,
        bestStreak: 1,
        roundStreaks: { 'user-one': 1 },
        bestStreaks: { 'user-one': 1 },
        usedWords: ['fusion'],
        hintedWords: ['nebula'],
        hintHistory: ['An earlier clue.'],
        processedMessageIds: [],
      },
    };
    const publisher = { send: vi.fn().mockResolvedValue('round-message-1') };
    const getWordChainHint = vi
      .fn<NonNullable<StemWordChainThemeValidator['getWordChainHint']>>()
      .mockResolvedValue({ word: 'nova', hint: 'A star that suddenly becomes much brighter.' });
    const themeValidator = {
      isWordInTheme: vi.fn<StemWordChainThemeValidator['isWordInTheme']>().mockResolvedValue(true),
      getWordChainHint,
    };
    const service = createService(state, publisher, themeValidator);
    const hint = createMessage('200', 'hint', { authorId: 'hint-user' });

    await service.handleMessage(hint);

    expect(getWordChainHint).toHaveBeenCalledWith('Space', 'n', ['fusion', 'nebula']);
    expect(hint.reply).toHaveBeenCalledWith(
      '💡 It starts with **N**. A star that suddenly becomes much brighter.',
    );
    expect(state.state).toMatchObject({
      stemWordChain: {
        hintedWords: ['nebula', 'nova'],
        hintHistory: ['An earlier clue.', 'A star that suddenly becomes much brighter.'],
      },
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

    expect(candidate.react).toHaveBeenCalledWith('⏳');
    expect(candidate.reply).toHaveBeenCalledWith(
      '⏳ I’m not sure I can check that word right now. The round is still open — please try another word in a moment.',
    );
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

  it('posts one automatic theme-aware clue after the chain has been idle', async () => {
    const state = new MemoryStateStore();
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('round-message-1')
        .mockResolvedValueOnce('hint-message-1'),
    };
    const getWordChainHint = vi
      .fn<NonNullable<StemWordChainThemeValidator['getWordChainHint']>>()
      .mockResolvedValue({ word: 'asteroid', hint: 'A rocky object that travels around the Sun.' });
    const themeValidator = {
      isWordInTheme: vi.fn<StemWordChainThemeValidator['isWordInTheme']>().mockResolvedValue(true),
      getWordChainHint,
    };
    const service = createService(state, publisher, themeValidator);

    await service.initialize();
    const wordChainState = state.state.stemWordChain as { lastActivityAt: string };
    wordChainState.lastActivityAt = '2026-10-19T02:00:00.000Z';
    await service.checkInactivity();
    await service.checkInactivity();

    expect(getWordChainHint).toHaveBeenCalledOnce();
    expect(publisher.send).toHaveBeenCalledTimes(2);
    expect(publisher.send.mock.calls[1]?.[1]).toContain(
      '💡 The word chain has gone quiet, so here is an extra clue for **Space**:',
    );
    expect(state.state).toMatchObject({
      stemWordChain: {
        hintHistory: ['A rocky object that travels around the Sun.'],
        hintedWords: ['asteroid'],
        automaticHintAt: '2026-10-23T02:00:00.000Z',
        streak: 0,
      },
    });
  });

  it('formats the theme and chain rules in the opening message', () => {
    expect(formatStemWordChainRound(STEM_WORD_CHAIN_THEMES[0]!, 3)).toBe(
      '🔗 **Word Chain 3**\n\nTheme: **Space**\n\nStart with any word that fits the theme. Each next word must start with the last letter of the previous word.\n\nWords cannot be repeated in the same round.\n\nA word outside the theme or the wrong starting letter ends the round and changes the theme.',
    );
  });
});
