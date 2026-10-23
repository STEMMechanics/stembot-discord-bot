import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { ScrambleWord, ScrambleWordGenerator } from '../src/integrations/openai-scramble.js';
import {
  formatStemScramble,
  PersistentStemScrambleService,
  scrambleWord,
  type StemScrambleConfig,
  type StemScrambleMessage,
  type StemScramblePublisher,
} from '../src/services/scramble.js';
import type { UserLevelService } from '../src/services/user-levels.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: StemScrambleConfig = {
  enabled: true,
  channelId: 'scramble-channel',
  retryIntervalMs: 300000,
  topic: 'mixed STEM',
  targetAgeMin: 8,
  targetAgeMax: 14,
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

function word(word: string, hint = `A clue for ${word}.`): ScrambleWord {
  return { word, hint };
}

function createMessage(
  authorId: string,
  id: string,
  content: string,
  overrides: Partial<StemScrambleMessage> = {},
): StemScrambleMessage {
  return {
    id,
    channelId: 'scramble-channel',
    authorId,
    authorIsBot: false,
    content,
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService(
  state: MemoryStateStore,
  generator: ScrambleWordGenerator,
  publisher: StemScramblePublisher = { send: vi.fn().mockResolvedValue('scramble-message-1') },
  userLevels?: UserLevelService,
): PersistentStemScrambleService {
  return new PersistentStemScrambleService({
    config,
    generator,
    publisher,
    state,
    logger,
    ...(userLevels ? { userLevels } : {}),
    clock: () => new Date('2026-10-23T02:00:00.000Z'),
    random: () => 0.9,
    idFactory: vi
      .fn<() => string>()
      .mockReturnValueOnce('round-1')
      .mockReturnValueOnce('round-2')
      .mockReturnValue('round-n'),
  });
}

describe('STEM scramble service', () => {
  it('scrambles locally, keeps wrong answers open and advances on the first correct answer', async () => {
    const state = new MemoryStateStore();
    const generator: ScrambleWordGenerator = {
      generateWord: vi
        .fn()
        .mockResolvedValueOnce(word('circuit'))
        .mockResolvedValueOnce(word('robot')),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('scramble-message-1')
        .mockResolvedValueOnce('scramble-message-2'),
    };
    const recordGameParticipation = vi.fn().mockResolvedValue(undefined);
    const userLevels = { recordGameParticipation } as unknown as UserLevelService;
    const service = createService(state, generator, publisher, userLevels);

    await service.initialize();
    const wrong = createMessage('user-1', 'wrong-1', 'not-it');
    await service.handleMessage(wrong);
    expect(wrong.react).toHaveBeenCalledWith('❌');
    expect(publisher.send).toHaveBeenCalledOnce();

    const correct = createMessage('user-1', 'correct-1', 'CIRCUIT');
    await service.handleMessage(correct);
    expect(correct.react).toHaveBeenCalledWith('✅');
    expect(recordGameParticipation).toHaveBeenCalledWith('user-1');
    expect(publisher.send).toHaveBeenCalledTimes(2);
    expect(publisher.send.mock.calls[1]?.[1]).not.toContain('solved it');
    expect(publisher.send.mock.calls[1]?.[1]).not.toContain('A clue for circuit.');
    await expect(service.getLeaderboard(3)).resolves.toEqual([{ userId: 'user-1', score: 1 }]);
    expect(state.state).toMatchObject({
      stemScramble: {
        nextRoundNumber: 3,
        round: { word: 'robot', roundNumber: 2 },
      },
    });
  });

  it('provides an additional clue without counting it as an answer', async () => {
    const state = new MemoryStateStore();
    const generateHint = vi
      .fn<NonNullable<ScrambleWordGenerator['generateHint']>>()
      .mockResolvedValue('It can carry electricity around a loop.');
    const generator: ScrambleWordGenerator = {
      generateWord: vi.fn().mockResolvedValue(word('circuit')),
      generateHint,
    };
    const publisher = { send: vi.fn().mockResolvedValue('scramble-message-1') };
    const service = createService(state, generator, publisher);
    const hint = createMessage('user-1', 'hint-1', 'hint');

    await service.initialize();
    await service.handleMessage(hint);

    expect(generateHint).toHaveBeenCalledWith({
      word: 'circuit',
      topic: 'mixed STEM',
      targetAgeMin: 8,
      targetAgeMax: 14,
      previousHints: ['A clue for circuit.'],
    });
    expect(hint.reply).toHaveBeenCalledWith(
      '💡 Another hint: It can carry electricity around a loop.',
    );
    expect(hint.react).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      stemScramble: {
        round: {
          word: 'circuit',
          wrongAttempts: 0,
          hints: ['A clue for circuit.', 'It can carry electricity around a loop.'],
        },
      },
    });
  });

  it('posts one automatic extra clue after the round has been idle', async () => {
    const state = new MemoryStateStore();
    const generateHint = vi
      .fn<NonNullable<ScrambleWordGenerator['generateHint']>>()
      .mockResolvedValue('It is commonly used to complete an electrical path.');
    const generator: ScrambleWordGenerator = {
      generateWord: vi.fn().mockResolvedValue(word('circuit')),
      generateHint,
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('scramble-message-1')
        .mockResolvedValueOnce('hint-message-1'),
    };
    const service = createService(state, generator, publisher);

    await service.initialize();
    const scrambleState = state.state.stemScramble as {
      round: { startedAt: string };
    };
    scrambleState.round.startedAt = '2026-10-19T02:00:00.000Z';
    await service.checkInactivity();
    await service.checkInactivity();

    expect(generateHint).toHaveBeenCalledOnce();
    expect(publisher.send).toHaveBeenCalledTimes(2);
    expect(publisher.send.mock.calls[1]?.[1]).toContain(
      '💡 The scramble has gone quiet, so here is an extra clue: It is commonly used',
    );
    expect(state.state).toMatchObject({
      stemScramble: { round: { automaticHintAt: '2026-10-23T02:00:00.000Z' } },
    });
  });

  it('skips an answer that was sent before the replacement scramble was posted', async () => {
    const state = new MemoryStateStore();
    const generator: ScrambleWordGenerator = {
      generateWord: vi
        .fn()
        .mockResolvedValueOnce(word('circuit'))
        .mockResolvedValueOnce(word('robot')),
    };
    const publisher = {
      send: vi.fn().mockResolvedValueOnce('200').mockResolvedValueOnce('400'),
    };
    const service = createService(state, generator, publisher);
    const first = createMessage('user-1', '300', 'circuit');
    const stale = createMessage('user-2', '350', 'circuit');

    await service.initialize();
    await service.handleMessage(first);
    await service.handleMessage(stale);

    expect(first.react).toHaveBeenCalledWith('✅');
    expect(stale.react).not.toHaveBeenCalled();
    expect(state.state).toMatchObject({
      stemScramble: {
        round: { word: 'robot', messageId: '400', wrongAttempts: 0 },
      },
    });
  });

  it('passes recent words to the generator and regenerates an exact duplicate', async () => {
    const state = new MemoryStateStore();
    const generateWord = vi
      .fn<ScrambleWordGenerator['generateWord']>()
      .mockResolvedValueOnce(word('circuit'))
      .mockResolvedValueOnce(word('circuit'))
      .mockResolvedValueOnce(word('robot'));
    const generator: ScrambleWordGenerator = { generateWord };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('scramble-message-1')
        .mockResolvedValueOnce('scramble-message-2'),
    };
    const service = createService(state, generator, publisher);

    await service.initialize();
    await service.handleMessage(createMessage('user-1', 'correct-1', 'circuit'));

    expect(generateWord).toHaveBeenCalledTimes(3);
    expect(generateWord.mock.calls[1]?.[0]).toMatchObject({ avoidWords: ['circuit'] });
    expect(state.state).toMatchObject({
      stemScramble: {
        recentWords: ['circuit', 'robot'],
        round: { word: 'robot' },
      },
    });
  });

  it('reveals the answer after five wrong guesses and advances the round', async () => {
    const state = new MemoryStateStore();
    const generator: ScrambleWordGenerator = {
      generateWord: vi
        .fn()
        .mockResolvedValueOnce(word('circuit'))
        .mockResolvedValueOnce(word('robot')),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('scramble-message-1')
        .mockResolvedValueOnce('scramble-message-2'),
    };
    const service = createService(state, generator, publisher);

    await service.initialize();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await service.handleMessage(createMessage('user-1', `wrong-${attempt}`, 'not-it'));
    }

    expect(publisher.send).toHaveBeenCalledTimes(2);
    expect(publisher.send.mock.calls[1]?.[1]).toContain('The answer was **circuit**.');
    expect(state.state).toMatchObject({
      stemScramble: {
        nextRoundNumber: 3,
        round: { word: 'robot', wrongAttempts: 0 },
      },
    });
  });

  it('resets an active round and starts a replacement round', async () => {
    const state = new MemoryStateStore();
    const generator: ScrambleWordGenerator = {
      generateWord: vi
        .fn()
        .mockResolvedValueOnce(word('circuit'))
        .mockResolvedValueOnce(word('robot')),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('scramble-message-1')
        .mockResolvedValueOnce('scramble-message-2'),
    };
    const service = createService(state, generator, publisher);

    await service.initialize();
    await expect(service.resetRound()).resolves.toBe('circuit');

    expect(publisher.send).toHaveBeenCalledTimes(2);
    expect(publisher.send.mock.calls[1]?.[1]).toContain(
      'The previous scramble was reset by a moderator',
    );
    expect(state.state).toMatchObject({
      stemScramble: {
        round: { word: 'robot', roundNumber: 2 },
      },
    });
  });

  it('discards a persisted round whose scrambled letters do not match its answer', async () => {
    const state = new MemoryStateStore();
    state.state = {
      stemScramble: {
        version: 1,
        nextRoundNumber: 2,
        round: {
          id: 'round-1',
          messageId: 'scramble-message-1',
          roundNumber: 1,
          word: 'magnet',
          hint: 'It can pull certain metals toward it.',
          scrambled: 'gmnta',
          startedAt: '2026-10-23T02:00:00.000Z',
        },
        recentWords: ['magnet'],
        processedMessageIds: [],
      },
    };
    const generator: ScrambleWordGenerator = {
      generateWord: vi.fn().mockResolvedValue(word('robot')),
    };
    const publisher = { send: vi.fn().mockResolvedValue('scramble-message-2') };
    const service = createService(state, generator, publisher);

    await service.initialize();

    expect(publisher.send).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      stemScramble: {
        round: { word: 'robot', roundNumber: 2 },
      },
    });
  });

  it('keeps the scrambled output different from the source word', () => {
    expect(scrambleWord('robot', () => 0.9)).not.toBe('robot');
    expect(formatStemScramble(word('robot', 'A machine that can sense and act.'), 'tobor', 4)).toBe(
      '🔤 **Scramble 4**\n\nUnscramble: `tobor`\n\nHint: A machine that can sense and act.',
    );
  });
});
