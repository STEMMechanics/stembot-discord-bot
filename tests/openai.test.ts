import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { OpenAINumberRecognizer, type NumberImage } from '../src/integrations/openai.js';

const logger = pino({ level: 'silent' });

const image: NumberImage = {
  contentType: 'image/gif',
  data: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'),
};

describe('OpenAI number recognizer', () => {
  it('sends image frames and parses the structured number response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: '{"number": 17}' }],
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const recognizer = new OpenAINumberRecognizer({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'low',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(recognizer.recognizeNumber(image)).resolves.toBe(17);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const request = fetchImplementation.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    const body = JSON.parse(String(request?.body)) as {
      model: string;
      reasoning: { effort: string };
      input: Array<{
        content: Array<{ type: string; image_url?: string; text?: string }>;
      }>;
      text: { format: { type: string; name: string } };
    };
    expect(body.model).toBe('test-model');
    expect(body.reasoning.effort).toBe('low');
    expect(JSON.parse(String(request?.body)).max_output_tokens).toBe(512);
    expect(body.input[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'input_text' }),
        expect.objectContaining({
          type: 'input_image',
          image_url: expect.stringContaining('data:image/png;base64,'),
        }),
      ]),
    );
    const prompt = body.input[0]?.content.find((content) => content.type === 'input_text');
    expect(prompt).toMatchObject({
      text: expect.stringContaining('not one, but two'),
    });
    expect(prompt?.text).toContain('holding up two fingers for 2');
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'counting_chain_number',
    });
  });

  it('returns null when the model cannot identify an unambiguous number', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: '{"number": null}',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const recognizer = new OpenAINumberRecognizer({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'low',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(recognizer.recognizeNumber(image)).resolves.toBeNull();
  });

  it('retries an incomplete high-effort response with low reasoning effort', async () => {
    const incompleteResponse = new Response(
      JSON.stringify({
        id: 'response-incomplete',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', content: [] }],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(incompleteResponse)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: '{"number": 17}' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const recognizer = new OpenAINumberRecognizer({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'max',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(recognizer.recognizeNumber(image)).resolves.toBe(17);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const retryRequest = fetchImplementation.mock.calls[1]?.[1];
    expect(JSON.parse(String(retryRequest?.body)).reasoning.effort).toBe('low');
  });

  it('reports an incomplete low-effort response when no structured output is returned', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'response-incomplete',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'reasoning', content: [] }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const recognizer = new OpenAINumberRecognizer({
      apiKey: 'test-key',
      model: 'test-model',
      reasoningEffort: 'low',
      timeoutMs: 1000,
      logger,
      fetchImplementation,
    });

    await expect(recognizer.recognizeNumber(image)).rejects.toThrow(
      'status=incomplete, reason=max_output_tokens',
    );
  });
});
