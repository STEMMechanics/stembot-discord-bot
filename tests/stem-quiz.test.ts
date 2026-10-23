import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { StemQuizEngine, StemQuizQuestion } from '../src/integrations/openai-quiz.js';
import {
  PersistentStemQuizService,
  type StemQuizConfig,
  type StemQuizMessage,
  type StemQuizPublisher,
} from '../src/services/stem-quiz.js';
import type { JsonState, StateStore } from '../src/state/state-store.js';

const logger = pino({ level: 'silent' });
const config: StemQuizConfig = {
  enabled: true,
  channelId: 'quiz-channel',
  maxWrongAnswers: 5,
  targetAgeMin: 8,
  targetAgeMax: 14,
  olderAgeMax: 18,
  olderPlayerRate: 0.15,
  topic: 'mixed STEM',
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

function question(answer: string, prompt = `What is the answer ${answer}?`): StemQuizQuestion {
  return {
    prompt,
    answer,
    acceptedAnswers: [answer],
    explanation: `The answer is ${answer}.`,
  };
}

function createMessage(
  authorId: string,
  id: string,
  content: string,
  overrides: Partial<StemQuizMessage> = {},
): StemQuizMessage {
  return {
    id,
    channelId: 'quiz-channel',
    authorId,
    authorIsBot: false,
    content,
    react: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService(
  state: MemoryStateStore,
  engine: StemQuizEngine,
  publisher: StemQuizPublisher = { send: vi.fn().mockResolvedValue('question-message-1') },
  options: Partial<StemQuizConfig> = {},
): PersistentStemQuizService {
  return new PersistentStemQuizService({
    config: { ...config, ...options },
    engine,
    publisher,
    state,
    logger,
    clock: () => new Date('2026-10-23T02:00:00.000Z'),
    random: () => 0.9,
    idFactory: vi
      .fn<() => string>()
      .mockReturnValueOnce('question-1')
      .mockReturnValueOnce('question-2')
      .mockReturnValue('question-n'),
  });
}

describe('STEM quiz service', () => {
  it('posts an age-targeted question when the game starts', async () => {
    const state = new MemoryStateStore();
    const engine: StemQuizEngine = {
      generateQuestion: vi.fn().mockResolvedValue(question('water')),
      evaluateAnswer: vi.fn(),
    };
    const publisher = { send: vi.fn().mockResolvedValue('question-message-1') };
    const service = createService(state, engine, publisher);

    await service.initialize();

    expect(engine.generateQuestion).toHaveBeenCalledWith({
      topic: 'mixed STEM',
      targetAgeMin: 8,
      targetAgeMax: 14,
      olderAgeMax: 18,
      olderPlayerChallenge: false,
    });
    expect(publisher.send).toHaveBeenCalledWith(
      'quiz-channel',
      expect.stringContaining('🧠 **Question 1**'),
    );
    expect(publisher.send.mock.calls[0]?.[1]).not.toContain(
      'The first correct answer earns 1 point',
    );
    expect(state.state).toMatchObject({
      stemQuiz: {
        nextQuestionNumber: 2,
        question: {
          id: 'question-1',
          messageId: 'question-message-1',
          wrongAttempts: 0,
        },
      },
    });
  });

  it('awards the first exact answer and posts the next question', async () => {
    const state = new MemoryStateStore();
    const engine: StemQuizEngine = {
      generateQuestion: vi
        .fn()
        .mockResolvedValueOnce(question('water'))
        .mockResolvedValueOnce(question('gravity')),
      evaluateAnswer: vi.fn(),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('question-message-1')
        .mockResolvedValueOnce('question-message-2'),
    };
    const service = createService(state, engine, publisher);
    const answer = createMessage('user-1', 'answer-1', 'Water');

    await service.initialize();
    await service.handleMessage(answer);

    expect(answer.react).toHaveBeenCalledWith('✅');
    expect(engine.evaluateAnswer).not.toHaveBeenCalled();
    expect(publisher.send).toHaveBeenLastCalledWith(
      'quiz-channel',
      expect.stringContaining('What is the answer gravity?'),
    );
    const nextQuestionMessage = String(publisher.send.mock.calls[1]?.[1]);
    expect(nextQuestionMessage).toContain('🎉 <@user-1> got it! **water** was correct.');
    expect(nextQuestionMessage).not.toMatch(/\bpoints?\b/i);
    expect(state.state).toMatchObject({
      stemQuiz: {
        question: { answer: 'gravity', questionNumber: 2 },
        scores: { 'user-1': 1 },
      },
    });
  });

  it('passes recent questions to the generator and regenerates an exact duplicate', async () => {
    const state = new MemoryStateStore();
    const generateQuestion = vi
      .fn<StemQuizEngine['generateQuestion']>()
      .mockResolvedValueOnce(question('water'))
      .mockResolvedValueOnce(question('water'))
      .mockResolvedValueOnce(question('gravity'));
    const engine: StemQuizEngine = {
      generateQuestion,
      evaluateAnswer: vi.fn(),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('question-message-1')
        .mockResolvedValueOnce('question-message-2'),
    };
    const service = createService(state, engine, publisher);

    await service.initialize();
    await service.handleMessage(createMessage('user-1', 'answer-1', 'water'));

    expect(generateQuestion).toHaveBeenCalledTimes(3);
    expect(generateQuestion.mock.calls[1]?.[0]).toMatchObject({
      avoidQuestions: [{ prompt: 'What is the answer water?', answer: 'water' }],
    });
    expect(generateQuestion.mock.calls[2]?.[0]).toMatchObject({
      avoidQuestions: [{ prompt: 'What is the answer water?', answer: 'water' }],
    });
    expect(state.state).toMatchObject({
      stemQuiz: {
        question: { answer: 'gravity' },
        recentQuestions: [
          { prompt: 'What is the answer water?', answer: 'water' },
          { prompt: 'What is the answer gravity?', answer: 'gravity' },
        ],
      },
    });
  });

  it('uses AI evaluation for a natural-language answer and awards only once', async () => {
    const state = new MemoryStateStore();
    const engine: StemQuizEngine = {
      generateQuestion: vi
        .fn()
        .mockResolvedValueOnce(question('observer'))
        .mockResolvedValueOnce(question('gravity')),
      evaluateAnswer: vi.fn().mockResolvedValue('correct'),
    };
    const publisher = { send: vi.fn().mockResolvedValue('question-message-1') };
    const service = createService(state, engine, publisher);
    const answer = createMessage('user-1', 'answer-1', 'It is the block that watches updates');

    await service.initialize();
    await service.handleMessage(answer);
    await service.handleMessage(answer);

    expect(engine.evaluateAnswer).toHaveBeenCalledOnce();
    expect(answer.react).toHaveBeenCalledWith('✅');
    expect(state.state).toMatchObject({ stemQuiz: { scores: { 'user-1': 1 } } });
  });

  it('keeps the question open for four wrong answers and reveals it on the fifth', async () => {
    const state = new MemoryStateStore();
    const engine: StemQuizEngine = {
      generateQuestion: vi
        .fn()
        .mockResolvedValueOnce(question('water'))
        .mockResolvedValueOnce(question('gravity')),
      evaluateAnswer: vi.fn().mockResolvedValue('incorrect'),
    };
    const publisher = {
      send: vi
        .fn()
        .mockResolvedValueOnce('question-message-1')
        .mockResolvedValueOnce('question-message-2'),
    };
    const service = createService(state, engine, publisher);
    await service.initialize();

    for (let index = 1; index <= 4; index += 1) {
      await service.handleMessage(createMessage(`user-${index}`, `wrong-${index}`, 'Nope'));
    }

    expect(publisher.send).toHaveBeenCalledOnce();
    expect(state.state).toMatchObject({
      stemQuiz: { question: { answer: 'water', wrongAttempts: 4 } },
    });

    const fifth = createMessage('user-5', 'wrong-5', 'Still nope');
    await service.handleMessage(fifth);

    expect(fifth.react).toHaveBeenCalledWith('❌');
    expect(publisher.send).toHaveBeenLastCalledWith(
      'quiz-channel',
      expect.stringContaining('The answer was **water**.'),
    );
    expect(state.state).toMatchObject({
      stemQuiz: { question: { answer: 'gravity', wrongAttempts: 0 } },
    });
  });

  it('does not change the question for an unclear answer', async () => {
    const state = new MemoryStateStore();
    const engine: StemQuizEngine = {
      generateQuestion: vi.fn().mockResolvedValue(question('water')),
      evaluateAnswer: vi.fn().mockResolvedValue('unclear'),
    };
    const service = createService(state, engine);
    const answer = createMessage('user-1', 'unclear-1', 'Maybe?');

    await service.initialize();
    await service.handleMessage(answer);

    expect(answer.react).toHaveBeenCalledWith('🤔');
    expect(state.state).toMatchObject({
      stemQuiz: { question: { answer: 'water', wrongAttempts: 0 } },
    });
  });

  it('acknowledges an evaluator failure without consuming an attempt', async () => {
    const state = new MemoryStateStore();
    const engine: StemQuizEngine = {
      generateQuestion: vi.fn().mockResolvedValue(question('water')),
      evaluateAnswer: vi.fn().mockRejectedValue(new Error('OpenAI unavailable')),
    };
    const service = createService(state, engine);
    const answer = createMessage('user-1', 'failed-evaluation-1', 'Water, I think');

    await service.initialize();
    await service.handleMessage(answer);

    expect(answer.react).toHaveBeenCalledWith('⚠️');
    expect(state.state).toMatchObject({
      stemQuiz: { question: { answer: 'water', wrongAttempts: 0 } },
    });
  });

  it('does not replace an active question after a restart', async () => {
    const state = new MemoryStateStore();
    const engine: StemQuizEngine = {
      generateQuestion: vi.fn().mockResolvedValue(question('water')),
      evaluateAnswer: vi.fn(),
    };
    const publisher = { send: vi.fn().mockResolvedValue('question-message-1') };
    const firstService = createService(state, engine, publisher);
    await firstService.initialize();

    const restartedService = createService(state, engine, publisher);
    await restartedService.initialize();

    expect(engine.generateQuestion).toHaveBeenCalledOnce();
    expect(publisher.send).toHaveBeenCalledOnce();
  });
});
