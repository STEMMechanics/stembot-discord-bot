import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenAIScrambleWordGenerator } from '../src/integrations/openai-scramble.js';

const logger = pino({ level: 'silent' });

function createGenerator(fetchImplementation: typeof fetch): OpenAIScrambleWordGenerator {
  return new OpenAIScrambleWordGenerator({
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'low',
    timeoutMs: 1000,
    logger,
    fetchImplementation,
  });
}

describe('OpenAI STEM scramble generator', () => {
  it('requests a structured age-appropriate word and includes recent words to avoid', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            word: 'redstone',
            hint: 'A material used to create circuits in a building game.',
          }),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const generator = createGenerator(fetchImplementation);

    await expect(
      generator.generateWord({
        topic: 'technology and computing',
        targetAgeMin: 8,
        targetAgeMax: 14,
        avoidWords: ['circuit', 'robot'],
      }),
    ).resolves.toEqual({
      word: 'redstone',
      hint: 'A material used to create circuits in a building game.',
    });

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      model: string;
      store: boolean;
      input: Array<{ content: Array<{ text?: string }> }>;
      text: { format: { name: string } };
    };
    expect(body.model).toBe('test-model');
    expect(body.store).toBe(false);
    expect(body.text.format.name).toBe('stem_scramble_word');
    expect(body.input[0]?.content[0]?.text).toContain('aged 8-14');
    expect(body.input[0]?.content[0]?.text).toContain('<recent-scramble-words>');
    expect(body.input[0]?.content[0]?.text).toContain('circuit');
  });

  it('rejects a response that is not a single scramble word', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({ word: 'red stone', hint: 'Too broad.' }),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const generator = createGenerator(fetchImplementation);

    await expect(
      generator.generateWord({
        topic: 'technology',
        targetAgeMin: 8,
        targetAgeMax: 14,
      }),
    ).rejects.toThrow('failed validation');
  });
});
