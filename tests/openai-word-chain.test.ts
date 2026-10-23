import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenAIStemWordChainValidator } from '../src/integrations/openai-word-chain.js';

const logger = pino({ level: 'silent' });

function createValidator(fetchImplementation: typeof fetch): OpenAIStemWordChainValidator {
  return new OpenAIStemWordChainValidator({
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'low',
    timeoutMs: 1000,
    logger,
    fetchImplementation,
  });
}

describe('OpenAI STEM word-chain validator', () => {
  it('evaluates a candidate word with a structured result', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: '{"valid":true}' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const validator = createValidator(fetchImplementation);

    await expect(validator.isWordInTheme('Biology', 'llama')).resolves.toBe(true);

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      model: string;
      store: boolean;
      reasoning: { effort: string };
      input: Array<{ content: Array<{ text?: string }> }>;
      text: { format: { type: string; name: string } };
    };
    expect(body.model).toBe('test-model');
    expect(body.store).toBe(false);
    expect(body.reasoning.effort).toBe('low');
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'stem_word_chain_validation',
    });
    expect(body.input[0]?.content[0]?.text).toContain('Theme: <theme>Biology</theme>');
    expect(body.input[0]?.content[0]?.text).toContain(
      'Candidate word: <candidate-word>llama</candidate-word>',
    );
  });

  it('returns false for an unrelated word', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: '{"valid":false}' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const validator = createValidator(fetchImplementation);

    await expect(validator.isWordInTheme('Technology', 'volcano')).resolves.toBe(false);
  });

  it('generates a concise definition with a separate structured result', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: '{"definition":"A natural satellite that orbits a planet."}',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const validator = createValidator(fetchImplementation);

    await expect(validator.getWordDefinition('Space', 'moon')).resolves.toBe(
      'A natural satellite that orbits a planet.',
    );

    const request = fetchImplementation.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      input: Array<{ content: Array<{ text?: string }> }>;
      text: { format: { name: string; schema: { properties: { definition: unknown } } } };
    };
    expect(body.text.format.name).toBe('stem_word_chain_definition');
    expect(body.text.format.schema.properties.definition).toBeDefined();
    expect(body.input[0]?.content[0]?.text).toContain('Word: <word>moon</word>');
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
        new Response(JSON.stringify({ output_text: '{"valid":true}' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const validator = new OpenAIStemWordChainValidator({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'max',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(validator.isWordInTheme('Technology', 'wire')).resolves.toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const retryRequest = fetchImplementation.mock.calls[1]?.[1];
    expect(JSON.parse(String(retryRequest?.body)).reasoning.effort).toBe('low');
  });
});
