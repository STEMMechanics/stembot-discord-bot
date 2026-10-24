import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenAICodeFixEngine } from '../src/integrations/openai-code-fix.js';
import { OpenAIWordRevealGenerator } from '../src/integrations/openai-word-reveal.js';

const logger = pino({ level: 'silent' });

describe('OpenAI Word Reveal generator', () => {
  it('requests a structured word and includes recent answers to avoid', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            word: 'orbit',
            hint: 'The curved path followed by a moon around a planet.',
          }),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const generator = new OpenAIWordRevealGenerator({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'low',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(
      generator.generateChallenge({
        topic: 'space science',
        targetAgeMin: 8,
        targetAgeMax: 14,
        avoidWords: ['planet', 'gravity'],
      }),
    ).resolves.toEqual({
      word: 'orbit',
      hint: 'The curved path followed by a moon around a planet.',
    });

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      store: boolean;
      text: { format: { name: string } };
      input: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(body.store).toBe(false);
    expect(body.text.format.name).toBe('stem_word_reveal_challenge');
    expect(body.input[0]?.content[0]?.text).toContain('aged 8-14');
    expect(body.input[0]?.content[0]?.text).toContain('<recent-word-reveal-answers>');
    expect(body.input[0]?.content[0]?.text).toContain('gravity');
  });
});

describe('OpenAI Code Fix engine', () => {
  it('generates a structured challenge and evaluates a natural-language fix', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              language: 'python',
              title: 'Area uses the wrong operation',
              prompt: 'This should calculate the area of a rectangle. What should be fixed?',
              code: 'area = width + height',
              answer: 'Change + to *',
              acceptedAnswers: ['multiply width by height'],
              explanation: 'Area is calculated by multiplying the two dimensions.',
            }),
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: '{"result":"correct"}' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const engine = new OpenAICodeFixEngine({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'low',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    const challenge = await engine.generateChallenge({
      topic: 'beginner programming',
      targetAgeMin: 8,
      targetAgeMax: 14,
      difficulty: 'advanced',
    });
    await expect(engine.evaluateAnswer(challenge, 'Multiply the width and height.')).resolves.toBe(
      'correct',
    );

    const generationBody = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      text: { format: { name: string } };
      input: Array<{ content: Array<{ text?: string }> }>;
    };
    const evaluationBody = JSON.parse(String(fetchImplementation.mock.calls[1]?.[1]?.body)) as {
      text: { format: { name: string } };
      input: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(generationBody.text.format.name).toBe('stem_code_fix_challenge');
    expect(generationBody.input[0]?.content[0]?.text).toContain('Difficulty: advanced');
    expect(evaluationBody.text.format.name).toBe('stem_code_fix_answer');
    expect(evaluationBody.input[0]?.content[0]?.text).toContain('Change + to *');
    expect(evaluationBody.input[0]?.content[0]?.text).toContain('Multiply the width and height.');
  });
});
