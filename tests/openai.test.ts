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
      input: Array<{ content: Array<{ type: string; image_url?: string }> }>;
      text: { format: { type: string; name: string } };
    };
    expect(body.model).toBe('test-model');
    expect(body.reasoning.effort).toBe('low');
    expect(body.input[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'input_text' }),
        expect.objectContaining({
          type: 'input_image',
          image_url: expect.stringContaining('data:image/png;base64,'),
        }),
      ]),
    );
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
});
