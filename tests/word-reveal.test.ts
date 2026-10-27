import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type {
  WordRevealChallenge,
  WordRevealGenerator,
} from '../src/integrations/openai-word-reveal.js';
import {
  formatStemWordReveal,
  PersistentStemWordRevealService,
  type StemWordRevealConfig,
  type StemWordRevealMessage,
  type StemWordRevealPublisher,
} from '../src/services/word-reveal.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: StemWordRevealConfig = {
  enabled: true,
  channelId: 'word-reveal-channel',
  retryIntervalMs: 300000,
  topic: 'mixed STEM',
  difficulty: 'standard',
  targetAgeMin: 8,
  targetAgeMax: 14,
  maxWrongGuesses: 2,
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

function challenge(word: string, hint = `A clue for ${word}.`): WordRevealChallenge {
  return { word, hint };
}

function createMessage(id: string, content: string): StemWordRevealMessage {
  return {
    id,
    channelId: 'word-reveal-channel',
    authorId: 'user-1',
    authorIsBot: false,
    content,
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function createService(
  state: MemoryStateStore,
  generator: WordRevealGenerator,
  publisher: StemWordRevealPublisher = {
    send: vi.fn().mockResolvedValue('round-message-1'),
  },
): PersistentStemWordRevealService {
  return new PersistentStemWordRevealService({
    config,
    generator,
    publisher,
    state,
    logger,
    clock: () => new Date('2026-10-23T02:00:00.000Z'),
    idFactory: vi.fn().mockReturnValueOnce('round-1').mockReturnValue('round-n'),
  });
}

describe('STEM Word Reveal service', () => {
  it('formats one hint and a masked word', () => {
    const formatted = formatStemWordReveal(
      challenge('atom', 'It is the smallest unit of an element.'),
      1,
    );
    expect(formatted).toMatchObject({
      title: '🕵️ Mystery Lab · Round 1',
      description: '💡 **Clue**\nIt is the smallest unit of an element.',
      color: 0x3498db,
    });
    expect(formatted.fields).toEqual([
      { name: '🔤 Guesses', value: '`none`', inline: false },
      { name: '🧩 Word', value: '🔵 🔵 🔵 🔵', inline: false },
    ]);
    expect(formatted.footer?.text).toContain('Guess one letter or the whole word');
  });

  it('accepts a letter, then a whole-word answer and records the solver', async () => {
    const state = new MemoryStateStore();
    const generator: WordRevealGenerator = {
      generateChallenge: vi
        .fn()
        .mockResolvedValueOnce(challenge('atom', 'It is the smallest unit of an element.'))
        .mockResolvedValueOnce(challenge('mars', 'A planet known for its reddish colour.')),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('round-message-1')
        .mockResolvedValueOnce('progress-message-1')
        .mockResolvedValueOnce('solved-message-1')
        .mockResolvedValueOnce('round-message-2'),
      edit: vi.fn().mockResolvedValue(true),
    };
    const service = createService(state, generator, publisher);
    const letter = createMessage('letter-1', 'a');
    const answer = createMessage('answer-1', 'atom');

    await service.initialize();
    await service.handleMessage(letter);
    await service.handleMessage(answer);

    expect(letter.react).toHaveBeenCalledWith('✅');
    expect(answer.react).toHaveBeenCalledWith('✅');
    expect(publisher.send).toHaveBeenCalledTimes(4);
    expect(publisher.edit).not.toHaveBeenCalled();
    expect(publisher.send).toHaveBeenCalledWith(
      'word-reveal-channel',
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            fields: expect.arrayContaining([
              { name: '🔤 Guesses', value: '`A`', inline: false },
              {
                name: '🧩 Word',
                value: ':regional_indicator_a: 🔵 🔵 🔵',
                inline: false,
              },
            ]),
          }),
        ],
      }),
    );
    await expect(service.getLeaderboard(3)).resolves.toEqual([{ userId: 'user-1', score: 1 }]);
    expect(state.state).toMatchObject({
      stemWordReveal: {
        nextRoundNumber: 3,
        round: { word: 'mars', roundNumber: 2 },
      },
    });
  });

  it('reveals the answer after the configured wrong-guess limit', async () => {
    const state = new MemoryStateStore();
    const generator: WordRevealGenerator = {
      generateChallenge: vi
        .fn()
        .mockResolvedValueOnce(challenge('atom', 'A tiny piece of matter.'))
        .mockResolvedValueOnce(challenge('mars', 'A planet known for its reddish colour.')),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('round-message-1')
        .mockResolvedValueOnce('progress-message-1')
        .mockResolvedValueOnce('revealed-message-1')
        .mockResolvedValueOnce('round-message-2'),
      edit: vi.fn().mockResolvedValue(true),
    };
    const service = createService(state, generator, publisher);

    await service.initialize();
    await service.handleMessage(createMessage('wrong-1', 'z'));
    await service.handleMessage(createMessage('wrong-2', 'q'));

    expect(publisher.edit).not.toHaveBeenCalled();
    expect(publisher.send).toHaveBeenCalledTimes(4);
    expect(publisher.send).toHaveBeenCalledWith(
      'word-reveal-channel',
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: expect.stringContaining('ATOM') })],
      }),
    );
    expect(state.state).toMatchObject({ stemWordReveal: { round: { word: 'mars' } } });
  });
});
