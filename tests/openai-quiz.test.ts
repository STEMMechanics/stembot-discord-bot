import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenAIStemQuizEngine, type StemQuizQuestion } from '../src/integrations/openai-quiz.js';

const logger = pino({ level: 'silent' });

const question: StemQuizQuestion = {
  type: 'short-answer',
  prompt: 'What force pulls objects towards Earth?',
  options: [],
  answer: 'gravity',
  acceptedAnswers: ['gravitational force'],
  explanation: 'Gravity pulls objects towards Earth.',
};

function createEngine(fetchImplementation: typeof fetch): OpenAIStemQuizEngine {
  return new OpenAIStemQuizEngine({
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'low',
    timeoutMs: 1000,
    logger,
    fetchImplementation,
  });
}

describe('OpenAI STEM quiz engine', () => {
  it('generates a structured age-targeted question with the shared model settings', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            type: 'multiple-choice',
            prompt: 'Which force pulls objects towards Earth?',
            options: ['Gravity', 'Friction'],
            answer: 'gravity',
            acceptedAnswers: ['gravitational force'],
            explanation: 'Gravity attracts objects towards Earth.',
          }),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const engine = createEngine(fetchImplementation);

    await expect(
      engine.generateQuestion({
        topic: 'mixed STEM',
        targetAgeMin: 8,
        targetAgeMax: 14,
        olderAgeMax: 18,
        olderPlayerChallenge: false,
        questionType: 'multiple-choice',
        avoidQuestions: [question],
      }),
    ).resolves.toEqual({
      type: 'multiple-choice',
      prompt: 'Which force pulls objects towards Earth?',
      options: ['Gravity', 'Friction'],
      answer: 'gravity',
      acceptedAnswers: ['gravitational force'],
      explanation: 'Gravity attracts objects towards Earth.',
    });

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      model: string;
      reasoning: { effort: string };
      text: { format: { type: string; name: string } };
      input: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(body.model).toBe('test-model');
    expect(body.reasoning.effort).toBe('low');
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'stem_quiz_question',
    });
    expect(body.input[0]?.content[0]?.text).toContain('aged 8-14');
    expect(body.input[0]?.content[0]?.text).toContain(
      'Use exactly this question type: multiple-choice.',
    );
    expect(body.input[0]?.content[0]?.text).toContain('redstone ticks');
    expect(body.input[0]?.content[0]?.text).toContain('metres');
    expect(body.input[0]?.content[0]?.text).toContain('Do not repeat any listed question');
    expect(body.input[0]?.content[0]?.text).toContain(
      '<recent-question-history>\nQuestion 1: What force pulls objects towards Earth?\nAnswer: gravity',
    );
  });

  it('evaluates a member answer with a structured result', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: '{"result":"correct"}' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const engine = createEngine(fetchImplementation);

    await expect(engine.evaluateAnswer(question, 'It is gravity')).resolves.toBe('correct');

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      text: { format: { name: string } };
      input: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(body.text.format.name).toBe('stem_quiz_answer');
    expect(body.input[0]?.content[0]?.text).toContain('It is gravity');
  });

  it('generates a structured hint without revealing the answer', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            hint: 'Think about the attraction between objects that have mass.',
          }),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const engine = createEngine(fetchImplementation);

    await expect(
      engine.generateHint(
        {
          ...question,
          type: 'short-answer',
        },
        ['Start by thinking about forces.'],
      ),
    ).resolves.toBe('Think about the attraction between objects that have mass.');

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      text: { format: { name: string } };
      input: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(body.text.format.name).toBe('stem_quiz_hint');
    expect(body.input[0]?.content[0]?.text).toContain('without giving away the answer');
    expect(body.input[0]?.content[0]?.text).toContain(
      '<previous-hints>\nStart by thinking about forces.\n</previous-hints>',
    );
  });

  it('retries an incomplete high-effort response with the shared low setting', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'reasoning', content: [] }],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              type: 'short-answer',
              prompt: 'What is 2 plus 2?',
              options: [],
              answer: '4',
              acceptedAnswers: ['four'],
              explanation: 'Two plus two equals four.',
            }),
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    const engine = new OpenAIStemQuizEngine({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'max',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(
      engine.generateQuestion({
        topic: 'maths',
        targetAgeMin: 8,
        targetAgeMax: 14,
        olderAgeMax: 18,
        olderPlayerChallenge: true,
      }),
    ).resolves.toMatchObject({ answer: '4' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const retryRequest = fetchImplementation.mock.calls[1]?.[1];
    expect(JSON.parse(String(retryRequest?.body)).reasoning.effort).toBe('low');
  });
});
