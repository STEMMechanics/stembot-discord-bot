import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { CodeFixChallenge, CodeFixEngine } from '../src/integrations/openai-code-fix.js';
import {
  formatStemCodeFix,
  PersistentStemCodeFixService,
  type StemCodeFixConfig,
  type StemCodeFixMessage,
  type StemCodeFixPublisher,
} from '../src/services/code-fix.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: StemCodeFixConfig = {
  enabled: true,
  channelId: 'code-fix-channel',
  retryIntervalMs: 300000,
  topic: 'beginner programming',
  targetAgeMin: 8,
  targetAgeMax: 14,
  difficulty: 'intermediate',
  maxWrongAnswers: 2,
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

function challenge(title = 'Area uses the wrong operation'): CodeFixChallenge {
  return {
    language: 'python',
    title,
    prompt: 'This should calculate the area of a rectangle. What should be fixed?',
    code: 'width = 5\nheight = 3\narea = width + height\nprint(area)',
    answer: 'Change + to *',
    acceptedAnswers: ['multiply width by height', 'use width * height'],
    explanation: 'Area is found by multiplying width by height.',
  };
}

function createMessage(id: string, content: string): StemCodeFixMessage {
  return {
    id,
    channelId: 'code-fix-channel',
    authorId: 'user-1',
    authorIsBot: false,
    content,
    react: vi.fn().mockResolvedValue(undefined),
  };
}

function createService(
  state: MemoryStateStore,
  engine: CodeFixEngine,
  publisher: StemCodeFixPublisher = { send: vi.fn().mockResolvedValue('challenge-message-1') },
): PersistentStemCodeFixService {
  return new PersistentStemCodeFixService({
    config,
    engine,
    publisher,
    state,
    logger,
    clock: () => new Date('2026-10-23T02:00:00.000Z'),
    idFactory: vi.fn().mockReturnValueOnce('challenge-1').mockReturnValue('challenge-n'),
  });
}

describe('STEM Code Fix service', () => {
  it('formats a small code challenge with a language fence', () => {
    expect(formatStemCodeFix(challenge(), 1)).toContain(
      '```python\nwidth = 5\nheight = 3\narea = width + height\nprint(area)\n```',
    );
    expect(formatStemCodeFix(challenge(), 1)).toContain('What should be fixed?');
  });

  it('keeps only the first code block when a generated sample includes duplicate fences', () => {
    const duplicateCode = [
      '```python',
      'width = 5',
      'height = 3',
      'area = width + height',
      'print(area)',
      '```',
      '',
      '```python',
      'width = 5',
      'height = 3',
      'area = width + height',
      'print(area)',
      '```',
    ].join('\n');

    const formatted = formatStemCodeFix({ ...challenge(), code: duplicateCode }, 1);

    expect(formatted.match(/```python/g)).toHaveLength(1);
    expect(formatted).toContain(
      '```python\nwidth = 5\nheight = 3\narea = width + height\nprint(area)\n```',
    );
  });

  it('converts triple-quoted generated code into one Discord code block', () => {
    const quotedCode = [
      '"""python',
      'width = 5',
      'height = 3',
      'area = width + height',
      'print(area)',
      '"""',
    ].join('\n');

    const formatted = formatStemCodeFix({ ...challenge(), code: quotedCode }, 1);

    expect(formatted).toContain(
      '```python\nwidth = 5\nheight = 3\narea = width + height\nprint(area)\n```',
    );
    expect(formatted).not.toContain('"""');
  });

  it('accepts an exact fix locally and records the solver', async () => {
    const state = new MemoryStateStore();
    const engine: CodeFixEngine = {
      generateChallenge: vi
        .fn()
        .mockResolvedValueOnce(challenge())
        .mockResolvedValueOnce(challenge('Loop condition needs checking')),
      evaluateAnswer: vi.fn(),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('challenge-message-1')
        .mockResolvedValueOnce('challenge-message-2'),
    };
    const service = createService(state, engine, publisher);

    await service.initialize();
    const answer = createMessage('answer-1', 'change + to *');
    await service.handleMessage(answer);

    expect(answer.react).toHaveBeenCalledWith('✅');
    expect(engine.evaluateAnswer).not.toHaveBeenCalled();
    await expect(service.getLeaderboard(3)).resolves.toEqual([{ userId: 'user-1', score: 1 }]);
    expect(state.state).toMatchObject({
      stemCodeFix: {
        nextChallengeNumber: 3,
        challenge: { title: 'Loop condition needs checking' },
      },
    });
  });

  it('uses the AI evaluator for an explanation that is not an exact variant', async () => {
    const state = new MemoryStateStore();
    const engine: CodeFixEngine = {
      generateChallenge: vi
        .fn()
        .mockResolvedValueOnce(challenge())
        .mockResolvedValueOnce(challenge('Loop condition needs checking')),
      evaluateAnswer: vi.fn().mockResolvedValue('correct'),
    };
    const service = createService(state, engine);

    await service.initialize();
    await service.handleMessage(
      createMessage('answer-1', 'The calculation should multiply the two dimensions.'),
    );

    expect(engine.evaluateAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ answer: 'Change + to *' }),
      'The calculation should multiply the two dimensions.',
    );
  });
});
