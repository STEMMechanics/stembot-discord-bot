import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenAIStemAskAnswerer } from '../src/integrations/openai-ask.js';

const logger = pino({ level: 'silent' });

function createAnswerer(fetchImplementation: typeof fetch): OpenAIStemAskAnswerer {
  return new OpenAIStemAskAnswerer({
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'low',
    timeoutMs: 1000,
    logger,
    fetchImplementation,
  });
}

describe('OpenAI STEM ask answerer', () => {
  it('answers a member question with the shared model settings', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: 'Gravity pulls objects towards Earth.' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const answerer = createAnswerer(fetchImplementation);

    await expect(answerer.answer('Why do objects fall?')).resolves.toBe(
      'Gravity pulls objects towards Earth.',
    );

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      model: string;
      reasoning: { effort: string };
      store: boolean;
      input: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(body.model).toBe('test-model');
    expect(body.reasoning.effort).toBe('low');
    expect(body.store).toBe(false);
    expect(body.input[0]?.content[0]?.text).toContain('youth-friendly');
    expect(body.input[0]?.content[0]?.text).toContain('do not identify yourself as ChatGPT');
    expect(body.input[0]?.content[0]?.text).toContain('avoid profanity');
    expect(body.input[1]?.content[0]?.text).toContain('Why do objects fall?');
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
        new Response(JSON.stringify({ output_text: 'Water freezes at 0°C.' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const answerer = new OpenAIStemAskAnswerer({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'max',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(answerer.answer('When does water freeze?')).resolves.toBe('Water freezes at 0°C.');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImplementation.mock.calls[1]?.[1]?.body)).reasoning.effort).toBe(
      'low',
    );
  });
});
