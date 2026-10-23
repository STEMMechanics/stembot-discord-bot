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
    expect(state.state).toMatchObject({
      stemScramble: {
        nextRoundNumber: 3,
        round: { word: 'robot', roundNumber: 2 },
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

  it('keeps the scrambled output different from the source word', () => {
    expect(scrambleWord('robot', () => 0.9)).not.toBe('robot');
    expect(formatStemScramble(word('robot', 'A machine that can sense and act.'), 'tobor', 4)).toBe(
      '🔤 **Scramble 4**\n\nUnscramble: `tobor`\n\nHint: A machine that can sense and act.',
    );
  });
});
